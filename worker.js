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
  // ALL PASSES
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
  function xorStrings(str, key) {
    let r = '';
    for (let i = 0; i < str.length; i++) r += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    return r;
  }
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

  // ── ENHANCED: Custom _0x4684-style decoder recovery ──────────────────────
  // This handles the specific pattern seen in the example:
  // function _0x4684(_0x37b3e5, _0x1e0178) {
  //   _0x37b3e5 = _0x37b3e5 - 108;
  //   const _0x642e61 = _0x642e();
  //   let _0x4684b9 = _0x642e61[_0x37b3e5];
  //   ... base64 stuff ...
  //   return _0x642e61[_0x37b3e5];
  // }
  // 
  // The key insight: the decoder function returns strings from the array,
  // and there's a Base64 wrapper function inside it. We need to:
  // 1. Extract the string array from _0x642e()
  // 2. Evaluate the decoder function for each call site
  // 3. Inline the decoded strings
  const customDecoderPass = {
    id: 'customDecoder', name: 'Custom _0x4684 Decoder Recovery', priority: 5, enabled: true,
    run(ast, { log }) {
      let inlined = 0;
      let decoderName = null;
      let arrayName = null;
      let offset = 0;
      let stringArray = null;
      
      // Step 1: Find the string array function _0x642e()
      let arrayFunctionName = null;
      const arrayStrings = [];
      
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id?.name;
          // Look for _0x642e() or similar that returns an array of strings
          if (!name || !/^_0x[a-fA-F0-9]+$/.test(name)) return;
          const body = path.node.body;
          if (!t.isBlockStatement(body)) return;
          
          // Check if this function returns an array literal
          for (const stmt of body.body) {
            if (t.isReturnStatement(stmt) && t.isArrayExpression(stmt.argument)) {
              const arr = stmt.argument.elements
                .filter(el => t.isStringLiteral(el))
                .map(el => el.value);
              if (arr.length > 10) {
                arrayFunctionName = name;
                arrayStrings.push(...arr);
                log('Found string array function: ' + name + ' with ' + arr.length + ' strings');
              }
              break;
            }
          }
        }
      });
      
      if (arrayStrings.length === 0) {
        log('No custom decoder string array found');
        return;
      }
      
      // Step 2: Find the decoder function that uses this array
      let decoderFunction = null;
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id?.name;
          if (!name || !/^_0x[a-fA-F0-9]+$/.test(name)) return;
          if (name === arrayFunctionName) return;
          
          const body = path.node.body;
          if (!t.isBlockStatement(body)) return;
          
          // Look for pattern: const _0xXXXX = _0xYYYY(); then return _0xYYYY[_0xZZZZ];
          let foundArray = false;
          let foundOffset = 0;
          let foundArrayName = null;
          
          for (const stmt of body.body) {
            if (t.isVariableDeclaration(stmt)) {
              for (const decl of stmt.declarations) {
                if (t.isIdentifier(decl.id) && t.isCallExpression(decl.init) && 
                    t.isIdentifier(decl.init.callee) && decl.init.callee.name === arrayFunctionName) {
                  foundArray = true;
                  foundArrayName = decl.id.name;
                }
              }
            }
            // Check for offset assignment: _0x37b3e5 = _0x37b3e5 - 108;
            if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression) &&
                t.isIdentifier(stmt.expression.left) && t.isBinaryExpression(stmt.expression.right) &&
                stmt.expression.right.operator === '-' && t.isNumericLiteral(stmt.expression.right.right)) {
              foundOffset = stmt.expression.right.right.value;
            }
          }
          
          if (foundArray && foundArrayName) {
            decoderFunction = path;
            decoderName = name;
            arrayName = foundArrayName;
            offset = foundOffset;
            log('Found decoder function: ' + name + ' using array ' + arrayName + ' with offset ' + offset);
          }
        }
      });
      
      if (!decoderFunction || !arrayName) {
        log('No custom decoder function found');
        return;
      }
      
      // Step 3: Inline all calls to the decoder function
      const stringArray = arrayStrings;
      
      traverse(ast, {
        CallExpression(path) {
          if (!t.isIdentifier(path.node.callee)) return;
          if (path.node.callee.name !== decoderName) return;
          
          const args = path.node.arguments;
          if (args.length < 1) return;
          
          // Try to resolve the index argument
          let idx = null;
          if (t.isNumericLiteral(args[0])) {
            idx = args[0].value - offset;
          } else if (t.isStringLiteral(args[0])) {
            const val = args[0].value;
            const num = /^0x[0-9a-fA-F]+$/.test(val) ? parseInt(val, 16) : parseInt(val, 10);
            if (!isNaN(num)) idx = num - offset;
          } else if (t.isBinaryExpression(args[0]) && args[0].operator === '-' && 
                     t.isIdentifier(args[0].left) && t.isNumericLiteral(args[0].right)) {
            // _0x37b3e5 - 108 pattern - we need the actual value
            // In the real code, this is already computed by the time we get here
            // so we just use the numeric literal
          }
          
          // Try to evaluate the expression
          if (idx !== null && idx >= 0 && idx < stringArray.length) {
            let decoded = stringArray[idx];
            // Check if there's a second argument (XOR key)
            if (args.length >= 2 && t.isStringLiteral(args[1])) {
              try {
                decoded = xorStrings(decoded, args[1].value);
              } catch(_) {}
            }
            path.replaceWith(t.stringLiteral(decoded));
            inlined++;
          } else {
            // Try to evaluate using a simple runtime approach
            // For the pattern _0x4684('0x0') we need to parse the hex
            if (t.isStringLiteral(args[0]) && args[0].value.startsWith('0x')) {
              const hexIdx = parseInt(args[0].value, 16) - offset;
              if (hexIdx >= 0 && hexIdx < stringArray.length) {
                let decoded = stringArray[hexIdx];
                if (args.length >= 2 && t.isStringLiteral(args[1])) {
                  try {
                    decoded = xorStrings(decoded, args[1].value);
                  } catch(_) {}
                }
                path.replaceWith(t.stringLiteral(decoded));
                inlined++;
              }
            }
          }
        }
      });
      
      // Step 4: Remove the decoder and array functions if they have no references left
      if (inlined > 0) {
        // Remove the array function if it's only used by the decoder
        traverse(ast, {
          FunctionDeclaration(path) {
            if (path.node.id?.name === arrayFunctionName) {
              const binding = path.scope.getBinding(arrayFunctionName);
              if (binding && binding.references === 0) {
                path.remove();
              }
            }
            if (path.node.id?.name === decoderName) {
              const binding = path.scope.getBinding(decoderName);
              if (binding && binding.references === 0) {
                path.remove();
              }
            }
          }
        });
        log('Inlined ' + inlined + ' custom decoder calls');
      }
    }
  };

  // ── Sandboxed Decoder Evaluation ────────────────────────────────────────────
  // WHY THIS PASS EXISTS:
  // zeroXDecoder (above) only recognizes the *trivial* decoder shape
  // `function _0xabc(i){ return _0xArr[i - OFFSET]; }`. Real javascript-obfuscator/
  // obfuscator.io output almost never looks like that once stringArrayEncoding
  // (base64/rc4) and the push/shift array-shuffle IIFE are enabled: the decoder
  // self-patches (`_0xabc = function(i,k){...}; return _0xabc(i,k);`), caches
  // results, and base64/RC4-decrypts each entry using a key argument. Statically
  // pattern-matching every possible shape of that is a losing game. Instead we
  // extract the actual helper machinery (array-provider function, shuffle IIFE,
  // decoder function, any object of tiny wrapper functions it depends on) and
  // *run it for real* in an isolated Function scope, then just ask it to decode
  // each call site. This also naturally handles the array-shuffle correctly,
  // since it's the real code executing, not a re-implementation of it.
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

  const sandboxDecoderPass = {
    id: 'sandboxDecoder', name: 'Sandboxed Decoder Evaluation (RC4/Base64/Shuffle-aware)', priority: 5.5, enabled: true,
    run(ast, { log }) {
      const program = ast.program;
      const HEX_NAME = /^_0x[a-f0-9]+$/i;
      const topLevelSrcParts = [];
      const candidateNames = new Set();

      // Top-level pass — preserves source ORDER, which matters here because the
      // array-provider function, the push/shift shuffle IIFE, and any top-level
      // `var`s all have real side-effect/initialization ordering dependencies.
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
          matched = true; // IIFE — likely the shuffle loop
        }
        if (matched) {
          try { topLevelSrcParts.push(generate(stmt, { compact: false }).code); } catch(_) {}
        }
      }

      // Nested pass — obfuscator.io commonly emits a small per-scope "offset
      // proxy" decoder (`function _0xabcd(a,b){ return _0xMAIN(a - N, b); }`)
      // LOCALLY inside each function that uses it, rather than at top level.
      // Function declarations hoist, so appending their source after the
      // top-level preamble is safe regardless of where they actually live.
      const seen = new Set(candidateNames);
      traverse(ast, {
        FunctionDeclaration(path2) {
          if (path2.parentPath.isProgram()) return; // already handled above
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

  function isFromCharCode(callee) {
    return t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: 'String' }) && t.isIdentifier(callee.property, { name: 'fromCharCode' });
  }
  function isPrintable(str) {
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); if (c < 9 || (c > 10 && c < 32)) return false; }
    return true;
  }
  function detectShiftDecoder(fn) {
    if (!fn?.body) return null;
    const body = t.isBlockStatement(fn.body) ? fn.body.body : null;
    if (!body || body.length !== 1) return null;
    const
