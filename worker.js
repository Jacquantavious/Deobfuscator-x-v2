let controller = null;
let registry = null;
let pipelineReady = false;
let pendingRun = null;

async function bootstrap() {
  const [
    { parse },
    generateMod,
    traverseMod,
    tMod,
    { format: prettierFormat },
    parserBabel,
    parserEstree,
  ] = await Promise.all([
    import('https://esm.sh/@babel/parser@7.23.6'),
    import('https://esm.sh/@babel/generator@7.23.6'),
    import('https://esm.sh/@babel/traverse@7.23.7'),
    import('https://esm.sh/@babel/types@7.23.6'),
    import('https://esm.sh/prettier@3.1.1/standalone'),
    import('https://esm.sh/prettier@3.1.1/plugins/babel'),
    import('https://esm.sh/prettier@3.1.1/plugins/estree'),
  ]);

  const generate = generateMod.default ?? generateMod;
  const traverse = traverseMod.default ?? traverseMod;
  const t = tMod;

  // ── ASTCache ───────────────────────────────────────────────────────────────
  const MAX_CACHE = 32;
  class ASTCache {
    constructor() { this._cache = new Map(); }
    _hash(str) {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
      return h.toString(36);
    }
    get(code) { const e = this._cache.get(this._hash(code)); if (e) { e.ts = Date.now(); return e.ast; } return null; }
    set(code, ast) {
      if (this._cache.size >= MAX_CACHE) {
        let ok = null, ot = Infinity;
        for (const [k, v] of this._cache) { if (v.ts < ot) { ok = k; ot = v.ts; } }
        if (ok) this._cache.delete(ok);
      }
      this._cache.set(this._hash(code), { ast, ts: Date.now() });
    }
  }
  const _cache = new ASTCache();

  // ── TransformRegistry ──────────────────────────────────────────────────────
  class TransformRegistry {
    constructor() { this._passes = new Map(); this._enabled = new Map(); }
    register(pass) {
      this._passes.set(pass.id, { priority: 50, enabled: true, ...pass });
      if (!this._enabled.has(pass.id)) this._enabled.set(pass.id, pass.enabled ?? true);
    }
    registerAll(passes) { for (const p of passes) this.register(p); }
    setEnabled(id, state) { this._enabled.set(id, state); }
    getAll() { return [...this._passes.values()].sort((a,b) => a.priority - b.priority); }
    getEnabled() { return this.getAll().filter(p => this._enabled.get(p.id) ?? p.enabled); }
    syncFromUI(map) { for (const [id, s] of Object.entries(map)) this._enabled.set(id, s); }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ════════════════════════════════════════════════════════════════════════════

  const PARSE_OPTS_INNER = { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true, plugins: ['jsx','typescript','classProperties','dynamicImport'] };

  function isEvalCallee(callee) {
    if (t.isIdentifier(callee, { name: 'eval' })) return true;
    if (t.isSequenceExpression(callee) && callee.expressions.length === 2 && t.isIdentifier(callee.expressions[1], { name: 'eval' })) return true;
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: 'eval' })) return true;
    return false;
  }

  function safeParseBlock(code) {
    try { const inner = parse(code, PARSE_OPTS_INNER); return t.blockStatement(inner.program.body); } catch(_) { return null; }
  }

  function tryInlineEval(path, code) {
    try {
      const inner = parse(code, PARSE_OPTS_INNER);
      const stmts = inner.program.body;
      if (stmts.length === 0) { if (path.parentPath.isExpressionStatement()) path.parentPath.remove(); else path.replaceWith(t.identifier('undefined')); return true; }
      if (path.parentPath.isExpressionStatement()) { path.parentPath.replaceWithMultiple(stmts); return true; }
      path.replaceWith(t.callExpression(t.arrowFunctionExpression([], t.blockStatement(stmts)), []));
      return true;
    } catch(_) { return false; }
  }

  function annotateNode(node, text) {
    if (!node.leadingComments) node.leadingComments = [];
    node.leadingComments.push({ type: 'CommentLine', value: ' [Deobfuscator-X] ' + text });
  }

  function isPrintable(str) {
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); if (c < 9 || (c > 10 && c < 32)) return false; }
    return true;
  }

  function xorStrings(str, key) {
    let r = '';
    for (let i = 0; i < str.length; i++) r += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    return r;
  }

  function resolveNumericArg(node) {
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isStringLiteral(node)) {
      const v = node.value.trim();
      const n = /^0[xX][0-9a-fA-F]+$/.test(v) ? parseInt(v, 16) : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    if (t.isUnaryExpression(node) && node.operator === '-') {
      const inner = resolveNumericArg(node.argument);
      return inner === null ? null : -inner;
    }
    return null;
  }

  function literalArgToJS(node) {
    if (t.isStringLiteral(node)) return { ok: true, value: node.value };
    if (t.isNumericLiteral(node)) return { ok: true, value: node.value };
    if (t.isBooleanLiteral(node)) return { ok: true, value: node.value };
    if (t.isNullLiteral(node)) return { ok: true, value: null };
    if (t.isUnaryExpression(node) && node.operator === '-') {
      const inner = literalArgToJS(node.argument);
      return inner.ok ? { ok: true, value: -inner.value } : { ok: false };
    }
    if (t.isBinaryExpression(node) && (node.operator === '+' || node.operator === '-')) {
      const l = literalArgToJS(node.left), r = literalArgToJS(node.right);
      if (l.ok && r.ok) return { ok: true, value: node.operator === '+' ? l.value + r.value : l.value - r.value };
    }
    return { ok: false };
  }

  function resolveIndex(property, computed) {
    if (!computed) return null;
    if (t.isNumericLiteral(property)) return property.value;
    if (t.isStringLiteral(property)) { const n = parseInt(property.value, 10); return isNaN(n) ? null : n; }
    if (t.isBinaryExpression(property)) {
      const { operator, left, right } = property;
      if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
        if (operator === '+') return left.value + right.value;
        if (operator === '-') return left.value - right.value;
      }
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 1: UNIVERSAL DECODER 
  // ════════════════════════════════════════════════════════════════════════════

  const universalDecoderPass = {
    id: 'universalDecoder', 
    name: 'Universal _0x4684 Decoder (Runtime Execution)', 
    priority: 4.5, 
    enabled: true,
    run(ast, { log }) {
      let inlined = 0;
      
      let arrayFunctionName = null;
      let stringArray = [];
      
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id?.name;
          if (!name || !/^_0x[a-f0-9]+$/i.test(name)) return;
          
          const body = path.node.body;
          if (!t.isBlockStatement(body)) return;
          
          for (const stmt of body.body) {
            if (t.isReturnStatement(stmt) && t.isArrayExpression(stmt.argument)) {
              const elements = stmt.argument.elements
                .filter(el => t.isStringLiteral(el))
                .map(el => el.value);
              if (elements.length > 10) {
                arrayFunctionName = name;
                stringArray = elements;
                log('Found string array: ' + name + ' with ' + elements.length + ' entries');
                return;
              }
            }
          }
        }
      });
      
      if (stringArray.length === 0) {
        log('No string array found');
        return;
      }
      
      let decoderName = null;
      let decoderOffset = 0;
      let arrayVarName = null;
      
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id?.name;
          if (!name || !/^_0x[a-f0-9]+$/i.test(name) || name === arrayFunctionName) return;
          
          const body = path.node.body;
          if (!t.isBlockStatement(body)) return;
          
          let foundArrayRef = false;
          let localArrayName = null;
          let localOffset = 0;
          
          for (const stmt of body.body) {
            if (t.isVariableDeclaration(stmt)) {
              for (const decl of stmt.declarations) {
                if (t.isCallExpression(decl.init) && 
                    t.isIdentifier(decl.init.callee) && 
                    decl.init.callee.name === arrayFunctionName) {
                  foundArrayRef = true;
                  localArrayName = decl.id.name;
                }
              }
            }
            
            if (t.isExpressionStatement(stmt) && 
                t.isAssignmentExpression(stmt.expression) &&
                t.isBinaryExpression(stmt.expression.right) &&
                stmt.expression.right.operator === '-' &&
                t.isNumericLiteral(stmt.expression.right.right)) {
              localOffset = stmt.expression.right.right.value;
            }
          }
          
          if (foundArrayRef && localArrayName) {
            decoderName = name;
            arrayVarName = localArrayName;
            decoderOffset = localOffset;
            log('Found decoder: ' + name + ' offset=' + localOffset);
          }
        }
      });
      
      if (!decoderName || !arrayVarName) {
        log('No decoder function found');
        return;
      }
      
      const callSites = [];
      traverse(ast, {
        CallExpression(path) {
          if (!t.isIdentifier(path.node.callee)) return;
          if (path.node.callee.name !== decoderName) return;
          
          const args = path.node.arguments.map(arg => {
            if (t.isStringLiteral(arg)) return { type: 'string', value: arg.value };
            if (t.isNumericLiteral(arg)) return { type: 'number', value: arg.value };
            if (t.isIdentifier(arg)) return { type: 'identifier', name: arg.name };
            return null;
          });
          
          if (args.length >= 1 && args[0]) {
            callSites.push({ path, args });
          }
        }
      });
      
      if (callSites.length === 0) {
        log('No calls to decoder found');
        return;
      }
      
      log('Found ' + callSites.length + ' calls to ' + decoderName);
      
      let decoderSource = '';
      let arraySource = '';
      
      traverse(ast, {
        FunctionDeclaration(path) {
          if (path.node.id?.name === decoderName) {
            try {
              decoderSource = generate(path.node, { compact: false }).code;
            } catch(_) {}
          }
          if (path.node.id?.name === arrayFunctionName) {
            try {
              arraySource = generate(path.node, { compact: false }).code;
            } catch(_) {}
          }
        }
      });
      
      if (!decoderSource || !arraySource) {
        log('Failed to extract source code for decoder/array');
        return;
      }
      
      let evaluated = 0;
      
      for (const site of callSites) {
        try {
          const arg0 = site.args[0];
          let arg0Value = '';
          
          if (arg0.type === 'string') {
            arg0Value = '"' + arg0.value + '"';
          } else if (arg0.type === 'number') {
            arg0Value = String(arg0.value);
          } else if (arg0.type === 'identifier') {
            let resolved = false;
            traverse(ast, {
              VariableDeclarator(path) {
                if (t.isIdentifier(path.node.id) && path.node.id.name === arg0.name && path.node.init) {
                  if (t.isStringLiteral(path.node.init)) {
                    arg0Value = '"' + path.node.init.value + '"';
                    resolved = true;
                  } else if (t.isNumericLiteral(path.node.init)) {
                    arg0Value = String(path.node.init.value);
                    resolved = true;
                  }
                }
              }
            });
            if (!resolved) {
              continue;
            }
          }
          
          const arg1 = site.args.length >= 2 ? site.args[1] : null;
          let arg1Value = '';
          if (arg1 && arg1.type === 'string') {
            arg1Value = ', "' + arg1.value + '"';
          } else if (arg1 && arg1.type === 'number') {
            arg1Value = ', ' + arg1.value;
          } else {
            arg1Value = ', ""';
          }
          
          const evalCode = `
            (function() {
              ${arraySource}
              ${decoderSource}
              return ${decoderName}(${arg0Value}${arg1Value});
            })()
          `;
          
          let result;
          try {
            result = new Function('return ' + evalCode)();
          } catch(_) {
            continue;
          }
          
          if (typeof result === 'string' && result.length > 0) {
            let decoded = result;
            
            if (/^[A-Za-z0-9+/]+={0,2}$/.test(decoded)) {
              try {
                const base64Decoded = atob(decoded);
                if (isPrintable(base64Decoded) && base64Decoded.length > 0) {
                  decoded = base64Decoded;
                }
              } catch(_) {}
            }
            
            if (decoded.includes('%')) {
              try {
                const urlDecoded = decodeURIComponent(decoded);
                if (isPrintable(urlDecoded) && urlDecoded.length > 0) {
                  decoded = urlDecoded;
                }
              } catch(_) {}
            }
            
            site.path.replaceWith(t.stringLiteral(decoded));
            evaluated++;
          }
        } catch(_) {
          continue;
        }
      }
      
      inlined = evaluated;
      
      if (inlined > 0) {
        let arrayRefs = 0;
        traverse(ast, {
          Identifier(path) {
            if (path.node.name === arrayFunctionName && !path.parentPath.isFunctionDeclaration()) {
              arrayRefs++;
            }
          }
        });
        
        if (arrayRefs === 0) {
          traverse(ast, {
            FunctionDeclaration(path) {
              if (path.node.id?.name === arrayFunctionName) {
                path.remove();
                log('Removed unused array function: ' + arrayFunctionName);
              }
            }
          });
        }
        
        let decoderRefs = 0;
        traverse(ast, {
          Identifier(path) {
            if (path.node.name === decoderName && !path.parentPath.isFunctionDeclaration()) {
              decoderRefs++;
            }
          }
        });
        
        if (decoderRefs === 0) {
          traverse(ast, {
            FunctionDeclaration(path) {
              if (path.node.id?.name === decoderName) {
                path.remove();
                log('Removed unused decoder function: ' + decoderName);
              }
            }
          });
        }
        
        log('Inlined ' + inlined + ' decoder calls');
      } else {
        log('Failed to evaluate any decoder calls');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 2: INFINITE LOOP REMOVAL
  // ════════════════════════════════════════════════════════════════════════════

  const infiniteLoopRemovalPass = {
    id: 'infiniteLoopRemoval', 
    name: 'Infinite Loop Removal (while(true))', 
    priority: 23, 
    enabled: true,
    run(ast, { log }) {
      let removed = 0;
      
      traverse(ast, {
        WhileStatement(path) {
          const test = path.node.test;
          const isTrue = t.isBooleanLiteral(test, { value: true }) || 
                         t.isNumericLiteral(test, { value: 1 });
          
          if (!isTrue) return;
          
          const body = path.node.body;
          if (!t.isBlockStatement(body)) return;
          
          const hasEffect = body.body.some(stmt => {
            if (t.isDebuggerStatement(stmt)) return false;
            if (t.isExpressionStatement(stmt) && 
                t.isCallExpression(stmt.expression) &&
                t.isIdentifier(stmt.expression.callee, { name: 'debugger' })) return false;
            return true;
          });
          
          if (hasEffect) return;
          
          path.remove();
          removed++;
        },
        
        CallExpression(path) {
          const callee = path.node.callee;
          if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return;
          
          const body = callee.body;
          if (!t.isBlockStatement(body)) return;
          
          let hasOnlyInfiniteLoop = true;
          
          for (const stmt of body.body) {
            if (t.isWhileStatement(stmt)) {
              const test = stmt.test;
              const isTrue = t.isBooleanLiteral(test, { value: true }) ||
                             t.isNumericLiteral(test, { value: 1 });
              if (isTrue && t.isBlockStatement(stmt.body) && stmt.body.body.length === 0) {
                continue;
              }
            }
            hasOnlyInfiniteLoop = false;
          }
          
          if (hasOnlyInfiniteLoop) {
            path.remove();
            removed++;
          }
        }
      });
      
      if (removed > 0) {
        log('Removed ' + removed + ' infinite loop(s)');
      } else {
        log('No infinite loops found');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 3: PROPERTY NAME DEOBFUSCATION
  // ════════════════════════════════════════════════════════════════════════════

  const propertyNameDeobfuscationPass = {
    id: 'propertyNameDeobfuscation',
    name: 'Property Name Deobfuscation',
    priority: 7,
    enabled: true,
    run(ast, { log }) {
      let resolved = 0;
      const decodedMap = new Map();
      
      let arrayFunctionName = null;
      
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id?.name;
          if (!name || !/^_0x[a-f0-9]+$/i.test(name)) return;
          
          const body = path.node.body;
          if (!t.isBlockStatement(body)) return;
          
          for (const stmt of body.body) {
            if (t.isReturnStatement(stmt) && t.isArrayExpression(stmt.argument)) {
              const elements = stmt.argument.elements
                .filter(el => t.isStringLiteral(el))
                .map(el => el.value);
              if (elements.length > 10) {
                arrayFunctionName = name;
                log('Found property name array: ' + name + ' with ' + elements.length + ' entries');
                break;
              }
            }
          }
        }
      });
      
      if (!arrayFunctionName) {
        log('No property name array found');
        return;
      }
      
      let decoderName = null;
      let decoderOffset = 0;
      
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id?.name;
          if (!name || !/^_0x[a-f0-9]+$/i.test(name) || name === arrayFunctionName) return;
          
          const body = path.node.body;
          if (!t.isBlockStatement(body)) return;
          
          let foundOffset = 0;
          let foundArrayRef = false;
          
          for (const stmt of body.body) {
            if (t.isExpressionStatement(stmt) && 
                t.isAssignmentExpression(stmt.expression) &&
                t.isBinaryExpression(stmt.expression.right) &&
                stmt.expression.right.operator === '-') {
              const right = stmt.expression.right;
              if (t.isIdentifier(right.left) && t.isNumericLiteral(right.right)) {
                foundOffset = right.right.value;
              }
            }
            
            if (t.isVariableDeclaration(stmt)) {
              for (const decl of stmt.declarations) {
                if (t.isCallExpression(decl.init) && 
                    t.isIdentifier(decl.init.callee) && 
                    decl.init.callee.name === arrayFunctionName) {
                  foundArrayRef = true;
                }
              }
            }
          }
          
          if (foundArrayRef && foundOffset > 0) {
            decoderName = name;
            decoderOffset = foundOffset;
            log('Found property decoder: ' + name + ' offset=' + foundOffset);
          }
        }
      });
      
      if (!decoderName) {
        log('No property decoder found');
        return;
      }
      
      let decoderSource = '';
      let arraySource = '';
      
      traverse(ast, {
        FunctionDeclaration(path) {
          if (path.node.id?.name === decoderName) {
            try {
              decoderSource = generate(path.node, { compact: false }).code;
            } catch(_) {}
          }
          if (path.node.id?.name === arrayFunctionName) {
            try {
              arraySource = generate(path.node, { compact: false }).code;
            } catch(_) {}
          }
        }
      });
      
      const obfuscatedStrings = new Set();
      traverse(ast, {
        StringLiteral(path) {
          const value = path.node.value;
          if (/^[A-Za-z0-9]{10,20}$/.test(value) && !decodedMap.has(value)) {
            obfuscatedStrings.add(value);
          }
        }
      });
      
      for (const str of obfuscatedStrings) {
        try {
          for (const offset of [decoderOffset, decoderOffset - 1, decoderOffset + 1, 108, 0]) {
            const evalCode = `
              (function() {
                ${arraySource}
                ${decoderSource}
                const idx = parseInt("${str}", 16) - ${offset};
                const arr = ${arrayFunctionName}();
                return arr[idx] || '';
              })()
            `;
            
            try {
              const result = new Function('return ' + evalCode)();
              if (typeof result === 'string' && result.length > 0 && result !== str) {
                if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(result)) {
                  decodedMap.set(str, result);
                  log('Decoded property: "' + str + '" → "' + result + '"');
                  break;
                }
              }
            } catch(_) {
              continue;
            }
          }
        } catch(_) {
          continue;
        }
      }
      
      if (decodedMap.size > 0) {
        traverse(ast, {
          StringLiteral(path) {
            const value = path.node.value;
            if (decodedMap.has(value)) {
              const decoded = decodedMap.get(value);
              const parent = path.parent;
              
              if (t.isMemberExpression(parent) && parent.property === path.node) {
                path.replaceWith(t.identifier(decoded));
                resolved++;
              } else if (t.isObjectProperty(parent) && parent.key === path.node && !parent.computed) {
                path.replaceWith(t.identifier(decoded));
                resolved++;
              }
            }
          }
        });
      }
      
      if (resolved > 0) {
        log('Resolved ' + resolved + ' obfuscated property name(s)');
      } else {
        log('No property names to resolve');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 4: RUNTIME PATTERN PASS
  // ════════════════════════════════════════════════════════════════════════════

  const runtimePatternPass = {
    id: 'runtimePatterns', name: 'Runtime Pattern Detection', priority: 3, enabled: true,
    run(ast, { log }) {
      let detected = 0, inlined = 0;
      traverse(ast, {
        CallExpression(path) {
          const { callee, arguments: args } = path.node;
          if (isEvalCallee(callee)) {
            detected++;
            if (args.length === 1 && t.isStringLiteral(args[0])) { if (tryInlineEval(path, args[0].value)) { inlined++; return; } }
            annotateNode(path.node, 'eval() — could not inline statically');
            return;
          }
          if (t.isIdentifier(callee) && (callee.name === 'setTimeout' || callee.name === 'setInterval') && args.length >= 1 && t.isStringLiteral(args[0])) {
            detected++;
            const block = safeParseBlock(args[0].value);
            if (block) { args[0] = t.arrowFunctionExpression([], block); inlined++; }
            else annotateNode(path.node, callee.name + '(string) — could not parse body');
          }
        },
        NewExpression(path) {
          if (!t.isIdentifier(path.node.callee, { name: 'Function' })) return;
          const args = path.node.arguments;
          if (args.length === 0) return;
          detected++;
          const bodyArg = args[args.length - 1];
          if (t.isStringLiteral(bodyArg)) {
            const block = safeParseBlock(bodyArg.value);
            if (block) {
              const paramIds = args.slice(0,-1).filter(a => t.isStringLiteral(a)).flatMap(a => a.value.split(',').map(s=>s.trim()).filter(Boolean)).map(n => t.identifier(n));
              path.replaceWith(t.functionExpression(null, paramIds, block));
              inlined++;
              return;
            }
          }
          annotateNode(path.node, 'new Function() — dynamic constructor');
        },
      });
      if (detected > 0) log('Found ' + detected + ' runtime pattern(s), inlined ' + inlined + ' statically');
      else log('No eval/Function/setTimeout(string) patterns found');
    },
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 5: ZEROX DECODER PASS
  // ════════════════════════════════════════════════════════════════════════════

  function analyzeDecoderFunction(path2, stringArrays, decoders) {
    let funcNode, funcName;
    if (path2.type === 'FunctionDeclaration') { funcNode = path2.node; funcName = funcNode.id?.name; }
    else if (path2.type === 'VariableDeclarator') { funcNode = path2.node.init; funcName = path2.node.id?.name; }
    if (!funcName || !/^_0x[a-fA-F0-9]+$/.test(funcName)) return;
    if (!funcNode?.body) return;
    const body = funcNode.body.body;
    if (!body || body.length === 0) return;
    for (const stmt of body) {
      if (!t.isReturnStatement(stmt)) continue;
      const ret = stmt.argument;
      if (!t.isMemberExpression(ret) || !t.isIdentifier(ret.object) || !stringArrays.has(ret.object.name)) continue;
      const prop = ret.property; const arrayName = ret.object.name;
      if (t.isIdentifier(prop)) { decoders.set(funcName, { arrayName, offset: 0, xorKey: null }); return; }
      if (t.isBinaryExpression(prop)) {
        const { operator, right } = prop;
        if (operator === '-' && t.isNumericLiteral(right)) { decoders.set(funcName, { arrayName, offset: right.value, xorKey: null }); return; }
        if (operator === '+' && t.isNumericLiteral(right)) { decoders.set(funcName, { arrayName, offset: -right.value, xorKey: null }); return; }
      }
    }
  }

  const zeroxDecoderPass = {
    id: 'zeroXDecoder', name: '_0x Decoder Recovery', priority: 5, enabled: true,
    run(ast, { log }) {
      let inlined = 0;
      const stringArrays = new Map();
      traverse(ast, {
        VariableDeclarator(path2) {
          const { id, init } = path2.node;
          if (!t.isIdentifier(id) || !t.isArrayExpression(init) || init.elements.length < 2) return;
          const strings = []; let sc = 0;
          for (const el of init.elements) { if (t.isStringLiteral(el)) { strings.push(el.value); sc++; } else strings.push(null); }
          if (sc / init.elements.length >= 0.5 && /^_0x[a-fA-F0-9]+$/.test(id.name)) stringArrays.set(id.name, strings);
        },
      });
      if (stringArrays.size === 0) { log('No _0x string arrays found'); return; }
      log('Found ' + stringArrays.size + ' string array(s): ' + [...stringArrays.keys()].join(', '));
      
      traverse(ast, {
        ExpressionStatement(path2) {
          const expr = path2.node.expression;
          if (!t.isCallExpression(expr)) return;
          let calleeFunc = null, args = expr.arguments;
          if (t.isFunctionExpression(expr.callee) && args.length === 2) calleeFunc = expr.callee;
          if (!calleeFunc) return;
          const arrayArg = args[0], countArg = args[1];
          if (!t.isIdentifier(arrayArg) || !stringArrays.has(arrayArg.name) || !t.isNumericLiteral(countArg)) return;
          const arr = [...stringArrays.get(arrayArg.name)];
          const rotations = countArg.value % arr.length;
          for (let i = 0; i < rotations; i++) arr.push(arr.shift());
          stringArrays.set(arrayArg.name, arr);
          log('Simulated rotation of ' + arrayArg.name + ' by ' + rotations + ' steps');
          path2.remove();
        },
      });
      
      const decoders = new Map();
      traverse(ast, {
        FunctionDeclaration(path2) { analyzeDecoderFunction(path2, stringArrays, decoders); },
        VariableDeclarator(path2) {
          if (t.isFunctionExpression(path2.node.init) || t.isArrowFunctionExpression(path2.node.init))
            analyzeDecoderFunction(path2, stringArrays, decoders);
        },
      });
      if (decoders.size > 0) log('Found ' + decoders.size + ' decoder function(s): ' + [...decoders.keys()].join(', '));
      
      const decoderNamesToRemove = new Set(decoders.keys());
      const arrayNamesToRemove = new Set(stringArrays.keys());
      
      traverse(ast, {
        CallExpression(path2) {
          if (!t.isIdentifier(path2.node.callee)) return;
          const fnName = path2.node.callee.name;
          if (!decoders.has(fnName)) return;
          const { arrayName, offset, xorKey } = decoders.get(fnName);
          const arr = stringArrays.get(arrayName);
          if (!arr) return;
          const indexArg = path2.node.arguments[0];
          const idxValue = resolveNumericArg(indexArg);
          if (idxValue === null) return;
          let idx = idxValue - offset;
          if (idx < 0 || idx >= arr.length) return;
          let str = arr[idx];
          if (str === null) return;
          if (xorKey && path2.node.arguments[1]) {
            const xargRaw = path2.node.arguments[1];
            if (t.isStringLiteral(xargRaw)) str = xorStrings(str, xargRaw.value);
          }
          path2.replaceWith(t.stringLiteral(str));
          inlined++;
        },
      });
      
      if (inlined > 0) {
        traverse(ast, {
          VariableDeclaration(path2) {
            path2.node.declarations = path2.node.declarations.filter(d => !t.isIdentifier(d.id) || (!arrayNamesToRemove.has(d.id.name) && !decoderNamesToRemove.has(d.id.name)));
            if (path2.node.declarations.length === 0) path2.remove();
          },
          FunctionDeclaration(path2) {
            if (t.isIdentifier(path2.node.id) && decoderNamesToRemove.has(path2.node.id.name)) path2.remove();
          },
        });
      }
      log('Inlined ' + inlined + ' _0x decoder call(s)');
    },
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 6: SANDOX DECODER PASS
  // ════════════════════════════════════════════════════════════════════════════

  const sandboxDecoderPass = {
    id: 'sandboxDecoder', name: 'Sandboxed Decoder Evaluation (RC4/Base64/Shuffle-aware)', priority: 5.5, enabled: true,
    run(ast, { log }) {
      const program = ast.program;
      const HEX_NAME = /^_0x[a-f0-9]+$/i;
      const topLevelSrcParts = [];
      const candidateNames = new Set();

      for (const stmt of program.body) {
        let matched = false;
        if (t.isFunctionDeclaration(stmt) && stmt.id && HEX_NAME.test(stmt.id.name)) {
          candidateNames.add(stmt.id.name); matched = true;
        } else if (t.isVariableDeclaration(stmt)) {
          for (const d of stmt.declarations) {
            if (t.isIdentifier(d.id) && HEX_NAME.test(d.id.name) &&
                (t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init) || t.isObjectExpression(d.init) || t.isArrayExpression(d.init) || t.isCallExpression(d.init))) {
              candidateNames.add(d.id.name); matched = true;
            }
          }
        } else if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression) &&
                   (t.isFunctionExpression(stmt.expression.callee) || t.isArrowFunctionExpression(stmt.expression.callee))) {
          matched = true;
        }
        if (matched) {
          try { topLevelSrcParts.push(generate(stmt, { compact: false }).code); } catch(_) {}
        }
      }

      const seen = new Set(candidateNames);
      traverse(ast, {
        FunctionDeclaration(path2) {
          if (path2.parentPath.isProgram()) return;
          const name = path2.node.id?.name;
          if (!name || !HEX_NAME.test(name) || seen.has(name)) return;
          seen.add(name); candidateNames.add(name);
          try { topLevelSrcParts.push(generate(path2.node, { compact: false }).code); } catch(_) {}
        },
      });
      if (candidateNames.size === 0) { log('No sandboxable decoder machinery found'); return; }

      const preamble = topLevelSrcParts.join('\n');
      let bindings = null;
      try {
        const exposeExpr = '({' + [...candidateNames].map(n => `${JSON.stringify(n)}: (typeof ${n} !== 'undefined' ? ${n} : undefined)`).join(',') + '})';
        const factory = new Function(preamble + '\nreturn ' + exposeExpr + ';');
        bindings = factory();
      } catch (err) { log('Sandbox setup failed: ' + err.message); return; }
      if (!bindings) { log('Sandbox produced no bindings'); return; }

      function resolveCallable(calleeNode) {
        if (t.isIdentifier(calleeNode)) {
          const fn = bindings[calleeNode.name];
          return typeof fn === 'function' ? fn : null;
        }
        if (t.isMemberExpression(calleeNode) && !calleeNode.computed && t.isIdentifier(calleeNode.object) && t.isIdentifier(calleeNode.property)) {
          const obj = bindings[calleeNode.object.name];
          if (obj && typeof obj === 'object') {
            const fn = obj[calleeNode.property.name];
            return typeof fn === 'function' ? fn : null;
          }
        }
        return null;
      }

      let inlined = 0, attempted = 0, budget = 20000;
      const cache = new Map();
      traverse(ast, {
        CallExpression(path2) {
          if (budget <= 0) return;
          const node = path2.node;
          const isCandidateCallee =
            (t.isIdentifier(node.callee) && candidateNames.has(node.callee.name)) ||
            (t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.object) && candidateNames.has(node.callee.object.name));
          if (!isCandidateCallee) return;
          const fn = resolveCallable(node.callee);
          if (!fn) return;
          const args = [];
          for (const argNode of node.arguments) {
            const r = literalArgToJS(argNode);
            if (!r.ok) return;
            args.push(r.value);
          }
          const cacheKey = (t.isIdentifier(node.callee) ? node.callee.name : node.callee.object.name + '.' + node.callee.property.name) + '(' + JSON.stringify(args) + ')';
          let result;
          if (cache.has(cacheKey)) { result = cache.get(cacheKey); }
          else {
            attempted++; budget--;
            try { result = fn(...args); } catch (_) { return; }
            cache.set(cacheKey, result);
          }
          if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
            path2.replaceWith(t.valueToNode(result));
            inlined++;
          }
        },
      });

      if (inlined > 0) {
        traverse(ast, { Program(path2) { path2.scope.crawl(); } });
        traverse(ast, {
          FunctionDeclaration(path2) {
            const name = path2.node.id?.name;
            if (name && candidateNames.has(name)) {
              const b = path2.scope.getBinding(name);
              if (b && b.references === 0) path2.remove();
            }
          },
          VariableDeclarator(path2) {
            if (t.isIdentifier(path2.node.id) && candidateNames.has(path2.node.id.name)) {
              const b = path2.scope.getBinding(path2.node.id.name);
              if (b && b.references === 0) {
                if (path2.parentPath.node.declarations.length === 1) path2.parentPath.remove();
                else path2.remove();
              }
            }
          },
        });
      }
      log('Executed sandboxed decoder machinery: ' + attempted + ' unique call(s) evaluated, ' + inlined + ' call site(s) inlined');
    },
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 7: STRING ARRAY CLEANUP PASS
  // ════════════════════════════════════════════════════════════════════════════

  const stringArrayCleanupPass = {
    id: 'stringArrayCleanup', name: 'Massive String Array Cleanup', priority: 6, enabled: true,
    run(ast, { log }) {
      let inlined = 0, arraysRemoved = 0;
      const candidates = new Map();
      traverse(ast, {
        VariableDeclarator(path2) {
          const { id, init } = path2.node;
          if (!t.isIdentifier(id) || !t.isArrayExpression(init) || init.elements.length < 2) return;
          const elements = init.elements.map(el => {
            if (t.isStringLiteral(el)) return el.value;
            if (t.isNumericLiteral(el)) return el.value;
            if (t.isNullLiteral(el)) return null;
            return undefined;
          });
          const sc = elements.filter(e => typeof e === 'string').length;
          if (sc / elements.length < 0.5 || elements.some(e => e === undefined)) return;
          candidates.set(id.name, elements);
        },
      });
      if (candidates.size === 0) { log('No large string arrays found'); return; }
      log('Found ' + candidates.size + ' string array(s): ' + [...candidates.keys()].join(', '));
      traverse(ast, {
        MemberExpression(path2) {
          if (!t.isIdentifier(path2.node.object)) return;
          const name = path2.node.object.name;
          if (!candidates.has(name)) return;
          const arr = candidates.get(name);
          const idx = resolveIndex(path2.node.property, path2.node.computed);
          if (idx === null || idx < 0 || idx >= arr.length) return;
          const val = arr[idx];
          if (val === null) return;
          if (typeof val === 'string') { path2.replaceWith(t.stringLiteral(val)); inlined++; }
          else if (typeof val === 'number') { path2.replaceWith(t.numericLiteral(val)); inlined++; }
        },
      });
      if (inlined > 0) {
        traverse(ast, {
          VariableDeclaration(path2) {
            const prev = path2.node.declarations.length;
            path2.node.declarations = path2.node.declarations.filter(d => !t.isIdentifier(d.id) || !candidates.has(d.id.name));
            arraysRemoved += prev - path2.node.declarations.length;
            if (path2.node.declarations.length === 0) path2.remove();
          },
        });
      }
      log('Inlined ' + inlined + ' array access(es), removed ' + arraysRemoved + ' array declaration(s)');
    },
  };

  // ════════════════════════════════════════════════════════════════════════════
  // REGISTER ALL PASSES
  // ════════════════════════════════════════════════════════════════════════════

  const reg = new TransformRegistry();
  reg.registerAll([
    universalDecoderPass,
    infiniteLoopRemovalPass,
    propertyNameDeobfuscationPass,
    runtimePatternPass,
    zeroxDecoderPass,
    sandboxDecoderPass,
    stringArrayCleanupPass,
  ]);
  
  registry = reg;
  pipelineReady = true;

  // ── Pipeline ───────────────────────────────────────────────────────────────
  async function runPipeline(code, options, passes, onProgress, signal) {
    const startTime = performance.now();
    const stats = { inputBytes: new TextEncoder().encode(code).length, inputLines: code.split('\n').length, passesRun: [], passesSkipped: [], parseTime: 0, transformTime: 0, generateTime: 0, totalTime: 0 };
    const emit = (p, l) => onProgress({ progress: p, label: l });

    emit(5, 'Parsing AST…');
    const parseStart = performance.now();
    let ast;
    try {
      ast = parse(code, { sourceType: 'unambiguous', allowImportExportEverywhere: true, allowReturnOutsideFunction: true, allowSuperOutsideMethod: true, allowUndeclaredExports: true, errorRecovery: true, plugins: ['jsx','typescript','classProperties','classPrivateProperties','classPrivateMethods','classStaticBlock','dynamicImport','exportDefaultFrom','exportNamespaceFrom','importMeta','nullishCoalescingOperator','optionalChaining','decorators-legacy','bigInt','numericSeparator','logicalAssignment'] });
    } catch(err) { stats.totalTime = performance.now() - startTime; return { ok: false, error: 'Parse error: ' + err.message, output: null, stats }; }
    stats.parseTime = performance.now() - parseStart;
    emit(15, 'AST ready in ' + stats.parseTime.toFixed(0) + 'ms');
    if (signal?.aborted) throw new DOMException('Pipeline aborted', 'AbortError');

    reg.syncFromUI(passes);
    const enabledPasses = options.beautifyOnly ? [] : reg.getEnabled();
    const transformStart = performance.now();

    for (let i = 0; i < enabledPasses.length; i++) {
      if (signal?.aborted) throw new DOMException('Pipeline aborted', 'AbortError');
      const pass = enabledPasses[i];
      const pct = 15 + Math.round(((i+1) / (enabledPasses.length + 1)) * 65);
      emit(pct, 'Running: ' + pass.name + '…');
      const passStart = performance.now();
      const messages = [];
      try {
        await pass.run(ast, { traverse, types: t, log: (msg) => { messages.push(msg); emit(pct, '[' + pass.id + '] ' + msg); }, signal });
        stats.passesRun.push({ id: pass.id, name: pass.name, duration: performance.now() - passStart, messages });
      } catch(err) {
        stats.passesSkipped.push({ id: pass.id, reason: err.message });
        emit(pct, '[WARN] "' + pass.name + '" failed: ' + err.message);
      }
    }
    stats.transformTime = performance.now() - transformStart;
    emit(82, 'Transforms done in ' + stats.transformTime.toFixed(0) + 'ms');
    if (signal?.aborted) throw new DOMException('Pipeline aborted', 'AbortError');

    stats.ast = ast;
    emit(85, 'Generating code…');
    const genStart = performance.now();
    let generated;
    try {
      const result = generate(ast, { retainLines: false, concise: false, quotes: 'single', jsescOption: { minimal: true } }, code);
      generated = result.code;
    } catch(err) { stats.totalTime = performance.now() - startTime; return { ok: false, error: 'Code generation error: ' + err.message, output: null, stats }; }
    stats.generateTime = performance.now() - genStart;

    if (signal?.aborted) throw new DOMException('Pipeline aborted', 'AbortError');
    emit(90, 'Beautifying output…');
    let output = generated;
    try {
      output = await prettierFormat(generated, { parser: 'babel', plugins: [parserBabel, parserEstree], printWidth: 100, tabWidth: 2, useTabs: false, semi: true, singleQuote: true, trailingComma: 'es5', bracketSpacing: true, arrowParens: 'avoid' });
    } catch(err) { emit(90, '[WARN] Prettier failed: ' + err.message); }

    stats.totalTime = performance.now() - startTime;
    stats.outputBytes = new TextEncoder().encode(output).length;
    stats.outputLines = output.split('\n').length;
    emit(100, 'Done in ' + stats.totalTime.toFixed(0) + 'ms');
    return { ok: true, output, stats };
  }

  // ── Message handler ────────────────────────────────────────────────────────
  self.addEventListener('message', async (event) => {
    const { type, payload } = event.data;
    if (type === 'ABORT') { controller?.abort(); return; }
    if (type !== 'RUN') return;
    controller?.abort();
    controller = new AbortController();
    const { code, options = {}, passes = {} } = payload;
    try {
      const result = await runPipeline(code, options, passes, ({ progress, label }) => {
        self.postMessage({ type: 'PROGRESS', progress, label });
      }, controller.signal);
      if (result.stats?.ast) result.stats.ast = null;
      self.postMessage({ type: 'RESULT', ...result });
    } catch(err) {
      if (err.name === 'AbortError') self.postMessage({ type: 'ABORTED' });
      else self.postMessage({ type: 'ERROR', message: err.message ?? String(err) });
    }
  });

  if (pendingRun) { self.dispatchEvent(new MessageEvent('message', { data: pendingRun })); pendingRun = null; }
}

self.addEventListener('message', (event) => {
  if (!pipelineReady && event.data?.type === 'RUN') pendingRun = event.data;
}, { once: false });

bootstrap().catch(err => {
  self.postMessage({ type: 'ERROR', message: 'Worker bootstrap failed: ' + err.message });
});
