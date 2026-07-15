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

  function isPrintable(str) {
    for (let i = 0; i < str.length; i++) { 
      const c = str.charCodeAt(i); 
      if (c < 9 || (c > 10 && c < 32)) return false; 
    }
    return true;
  }

  function hexDecode(str) {
    try {
      let result = '';
      for (let i = 0; i < str.length; i += 2) {
        result += String.fromCharCode(parseInt(str.substr(i, 2), 16));
      }
      return result;
    } catch(_) { return null; }
  }

  function base64Decode(str) {
    try { return atob(str); } catch(_) { return null; }
  }

  function urlDecode(str) {
    try { return decodeURIComponent(str); } catch(_) { return null; }
  }

  function tryDecodeString(str) {
    // Try hex decoding
    if (/^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0) {
      const hexDecoded = hexDecode(str);
      if (hexDecoded && isPrintable(hexDecoded) && hexDecoded.length > 0) {
        return hexDecoded;
      }
    }
    
    // Try hex with \x format
    if (str.includes('\\x')) {
      try {
        const unescaped = eval('"' + str + '"');
        if (unescaped && isPrintable(unescaped) && unescaped.length > 0) {
          return unescaped;
        }
      } catch(_) {}
    }
    
    // Try Unicode escape
    if (str.includes('\\u')) {
      try {
        const unescaped = eval('"' + str + '"');
        if (unescaped && isPrintable(unescaped) && unescaped.length > 0) {
          return unescaped;
        }
      } catch(_) {}
    }
    
    // Try Base64
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(str) && str.length > 4) {
      const b64 = base64Decode(str);
      if (b64 && isPrintable(b64) && b64.length > 0) {
        return b64;
      }
    }
    
    // Try URL decode
    if (str.includes('%')) {
      const url = urlDecode(str);
      if (url && isPrintable(url) && url.length > 0) {
        return url;
      }
    }
    
    return str;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 1: SIMPLE STRING ARRAY DEOBFUSCATION
  // Handles the example pattern: _0x1a2b = ['hello', 'world']; _0x3c4d = function(a) { return _0x1a2b[a]; }
  // ════════════════════════════════════════════════════════════════════════════

  const simpleStringArrayPass = {
    id: 'simpleStringArray',
    name: 'Simple String Array Deobfuscation',
    priority: 1,
    enabled: true,
    run(ast, { log }) {
      let decodedCount = 0;
      const arrayMap = new Map();
      
      // ── Step 1: Find string arrays and their decoder functions ──
      traverse(ast, {
        VariableDeclarator(path) {
          const id = path.node.id;
          const init = path.node.init;
          
          // Find array assignments: var _0x1a2b = ['hello', 'world'];
          if (t.isIdentifier(id) && t.isArrayExpression(init)) {
            const elements = init.elements
              .filter(el => t.isStringLiteral(el) || t.isNumericLiteral(el))
              .map(el => {
                if (t.isStringLiteral(el)) return el.value;
                if (t.isNumericLiteral(el)) return String(el.value);
                return null;
              })
              .filter(v => v !== null);
            
            if (elements.length >= 2) {
              arrayMap.set(id.name, { elements, decoder: null });
              log('Found string array: ' + id.name + ' with ' + elements.length + ' entries');
            }
          }
        }
      });

      if (arrayMap.size === 0) {
        log('No string arrays found');
        return;
      }

      // ── Step 2: Find decoder functions that reference the arrays ──
      for (const [arrayName, data] of arrayMap) {
        const inspectFn = (fnPath, name) => {
          if (!name || data.decoder) return;
          const body = fnPath.node.body;
          if (!t.isBlockStatement(body)) return;
          let refsArray = false;
          fnPath.traverse({
            MemberExpression(p) {
              if (t.isIdentifier(p.node.object) && p.node.object.name === arrayName) {
                refsArray = true;
              }
            }
          });
          if (refsArray) {
            data.decoder = name;
            log('Found decoder: ' + name + ' for array: ' + arrayName);
          }
        };

        const nameFromParent = (parent) => {
          if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
          if (t.isAssignmentExpression(parent) && t.isIdentifier(parent.left)) return parent.left.name;
          return null;
        };

        traverse(ast, {
          FunctionDeclaration(path) {
            inspectFn(path, path.node.id?.name);
          },
          FunctionExpression(path) {
            const name = path.node.id?.name || nameFromParent(path.parent);
            inspectFn(path, name);
          },
          ArrowFunctionExpression(path) {
            if (!t.isBlockStatement(path.node.body)) return;
            inspectFn(path, nameFromParent(path.parent));
          }
        });
      }

      // ── Step 3: Replace calls to the decoder functions ──
      for (const [arrayName, data] of arrayMap) {
        if (!data.decoder) continue;
        
        const decoderName = data.decoder;
        const elements = data.elements;
        
        traverse(ast, {
          CallExpression(path) {
            const callee = path.node.callee;
            if (!t.isIdentifier(callee)) return;
            if (callee.name !== decoderName) return;
            
            const args = path.node.arguments;
            if (args.length < 1) return;
            
            const arg = args[0];
            let idx = null;
            
            if (t.isStringLiteral(arg)) {
              const val = arg.value;
              if (val.startsWith('0x')) {
                idx = parseInt(val, 16);
              } else {
                idx = parseInt(val, 10);
              }
            } else if (t.isNumericLiteral(arg)) {
              idx = arg.value;
            }
            
            if (idx !== null && idx >= 0 && idx < elements.length) {
              const decoded = tryDecodeString(elements[idx]);
              path.replaceWith(t.stringLiteral(decoded));
              decodedCount++;
            }
          }
        });
      }

      // ── Step 4: Replace direct array accesses ──
      for (const [arrayName, data] of arrayMap) {
        traverse(ast, {
          MemberExpression(path) {
            const obj = path.node.object;
            const prop = path.node.property;
            
            if (!t.isIdentifier(obj)) return;
            if (obj.name !== arrayName) return;
            
            if (t.isNumericLiteral(prop) || t.isStringLiteral(prop)) {
              let idx = null;
              if (t.isNumericLiteral(prop)) {
                idx = prop.value;
              } else if (t.isStringLiteral(prop)) {
                idx = parseInt(prop.value, 10);
              }
              
              if (idx !== null && idx >= 0 && idx < data.elements.length) {
                const decoded = tryDecodeString(data.elements[idx]);
                path.replaceWith(t.stringLiteral(decoded));
                decodedCount++;
              }
            }
          }
        });
      }

      if (decodedCount > 0) {
        log('Decoded ' + decodedCount + ' strings from simple array');
      } else {
        log('No simple array strings decoded');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 2: COMPLEX _0x4684 STYLE DEOBFUSCATION
  // Handles the complex self-modifying decoder pattern
  // ════════════════════════════════════════════════════════════════════════════

  const complexDecoderPass = {
    id: 'complexDecoder',
    name: 'Complex _0x4684 Decoder Deobfuscation',
    priority: 2,
    enabled: true,
    run(ast, { log }) {
      let decodedCount = 0;
      let stringArray = [];
      let arrayFunctionName = null;
      let decoderName = null;
      const decoderOffset = 108;
      
      // ── Step 1: Find the string array function ──
      const nameFromParent = (parent) => {
        if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
        if (t.isAssignmentExpression(parent) && t.isIdentifier(parent.left)) return parent.left.name;
        return null;
      };

      const inspectArrayFn = (fnPath, name) => {
        if (!name || !/^_0x[a-f0-9]+$/i.test(name) || arrayFunctionName) return;
        const body = fnPath.node.body;
        if (!t.isBlockStatement(body)) return;
        for (const stmt of body.body) {
          if (t.isReturnStatement(stmt) && t.isArrayExpression(stmt.argument)) {
            const elements = stmt.argument.elements
              .filter(el => t.isStringLiteral(el))
              .map(el => el.value);
            if (elements.length > 10) {
              arrayFunctionName = name;
              stringArray = elements;
              log('Found complex string array: ' + name + ' with ' + elements.length + ' entries');
              return;
            }
          }
        }
      };

      traverse(ast, {
        FunctionDeclaration(path) {
          inspectArrayFn(path, path.node.id?.name);
        },
        FunctionExpression(path) {
          inspectArrayFn(path, path.node.id?.name || nameFromParent(path.parent));
        }
      });

      if (stringArray.length === 0) {
        log('No complex string array found');
        return;
      }

      // ── Step 2: Find the decoder function ──
      const inspectDecoderFn = (fnPath, name) => {
        if (!name || !/^_0x[a-f0-9]+$/i.test(name) || name === arrayFunctionName || decoderName) return;
        const body = fnPath.node.body;
        if (!t.isBlockStatement(body)) return;

        let hasArrayRef = false;
        for (const stmt of body.body) {
          if (t.isVariableDeclaration(stmt)) {
            for (const decl of stmt.declarations) {
              if (t.isCallExpression(decl.init) &&
                  t.isIdentifier(decl.init.callee) &&
                  decl.init.callee.name === arrayFunctionName) {
                hasArrayRef = true;
              }
            }
          }
        }

        if (hasArrayRef) {
          decoderName = name;
          log('Found complex decoder: ' + name);
        }
      };

      traverse(ast, {
        FunctionDeclaration(path) {
          inspectDecoderFn(path, path.node.id?.name);
        },
        FunctionExpression(path) {
          inspectDecoderFn(path, path.node.id?.name || nameFromParent(path.parent));
        }
      });

      if (!decoderName) {
        log('No complex decoder function found');
        return;
      }

      // ── Step 3: Decode all strings ──
      const decodedMap = new Map();

      for (const str of stringArray) {
        let decoded = tryDecodeString(str);
        // If the decoded string is still not readable, try to decode it again
        if (decoded === str || !isPrintable(decoded)) {
          // Try to decode as hex if it looks like hex
          if (/^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0) {
            const hexDecoded = hexDecode(str);
            if (hexDecoded && hexDecoded.length > 0) {
              decoded = tryDecodeString(hexDecoded);
            }
          }
        }
        decodedMap.set(str, decoded);
      }

      log('Decoded ' + decodedMap.size + ' complex strings');

      // ── Step 4: Replace decoder calls ──
      const callSites = [];
      traverse(ast, {
        CallExpression(path) {
          const callee = path.node.callee;
          if (t.isIdentifier(callee) && callee.name === decoderName) {
            const args = path.node.arguments;
            if (args.length >= 1) {
              callSites.push({ path, args });
            }
          }
        }
      });

      for (const site of callSites) {
        try {
          const arg = site.args[0];
          let idx = null;
          
          if (t.isStringLiteral(arg)) {
            const val = arg.value;
            if (val.startsWith('0x')) {
              idx = parseInt(val, 16) - decoderOffset;
            } else {
              idx = parseInt(val, 16) - decoderOffset;
            }
          } else if (t.isNumericLiteral(arg)) {
            idx = arg.value - decoderOffset;
          }

          if (idx !== null && idx >= 0 && idx < stringArray.length) {
            const original = stringArray[idx];
            const decoded = decodedMap.get(original);
            if (decoded && decoded !== original) {
              site.path.replaceWith(t.stringLiteral(decoded));
              decodedCount++;
            }
          }
        } catch(_) {}
      }

      if (decodedCount > 0) {
        log('Decoded ' + decodedCount + ' complex decoder calls');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 3: GENERAL STRING DEOBFUSCATION
  // Handles hex strings, Unicode escapes, etc.
  // ════════════════════════════════════════════════════════════════════════════

  const stringDeobfuscationPass = {
    id: 'stringDeobfuscation',
    name: 'General String Deobfuscation',
    priority: 3,
    enabled: true,
    run(ast, { log }) {
      let decodedCount = 0;
      
      traverse(ast, {
        StringLiteral(path) {
          const value = path.node.value;
          const raw = path.node.extra?.raw || '';
          
          // Babel already decodes \x.. / \u.... escapes into `value` at parse time;
          // the original escaped text is only kept in `extra.raw` for pretty-printing.
          // Replacing with a fresh StringLiteral (no `extra`) forces the generator to
          // print the already-decoded value instead of the original escaped source.
          if ((raw.includes('\\x') || raw.includes('\\u')) && isPrintable(value) && value.length > 0) {
            path.replaceWith(t.stringLiteral(value));
            decodedCount++;
            return;
          }
          
          // Try to decode if it's just hex
          if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0 && value.length > 4) {
            const hexDecoded = hexDecode(value);
            if (hexDecoded && isPrintable(hexDecoded) && hexDecoded.length > 0) {
              path.replaceWith(t.stringLiteral(hexDecoded));
              decodedCount++;
            }
          }
        }
      });
      
      if (decodedCount > 0) {
        log('Decoded ' + decodedCount + ' encoded strings');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 4: DEAD CODE REMOVAL
  // ════════════════════════════════════════════════════════════════════════════

  const deadCodeRemovalPass = {
    id: 'deadCodeRemoval',
    name: 'Dead Code Removal',
    priority: 4,
    enabled: true,
    run(ast, { log }) {
      let removed = 0;
      
      traverse(ast, {
        DebuggerStatement(path) {
          path.remove();
          removed++;
        },
        
        IfStatement(path) {
          const test = path.node.test;
          // Remove if(false) blocks
          if (t.isBooleanLiteral(test) && test.value === false) {
            if (path.node.alternate) {
              path.replaceWith(path.node.alternate);
            } else {
              path.remove();
            }
            removed++;
          }
          // Simplify if(true)
          if (t.isBooleanLiteral(test) && test.value === true) {
            path.replaceWith(path.node.consequent);
            removed++;
          }
          // Remove if(0 == 0) style
          if (t.isBinaryExpression(test) && 
              test.operator === '==' && 
              t.isNumericLiteral(test.left) && 
              t.isNumericLiteral(test.right) && 
              test.left.value === test.right.value) {
            path.replaceWith(path.node.consequent);
            removed++;
          }
        },
        
        CallExpression(path) {
          const callee = path.node.callee;
          // Remove setInterval with debugger
          if (t.isIdentifier(callee) && (callee.name === 'setInterval' || callee.name === 'setTimeout')) {
            const args = path.node.arguments;
            if (args.length >= 1) {
              const fn = args[0];
              // Check if it's a function that only contains debugger
              if (t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn)) {
                let hasOnlyDebugger = true;
                const body = fn.body;
                if (t.isBlockStatement(body)) {
                  for (const stmt of body.body) {
                    if (!t.isDebuggerStatement(stmt)) {
                      hasOnlyDebugger = false;
                      break;
                    }
                  }
                } else {
                  hasOnlyDebugger = false;
                }
                if (hasOnlyDebugger) {
                  if (path.parentPath.isExpressionStatement()) {
                    path.parentPath.remove();
                    removed++;
                  } else {
                    path.replaceWith(t.numericLiteral(0));
                    removed++;
                  }
                }
              }
            }
          }
        },
        
        // Remove unreachable code after return/break/continue
        BlockStatement: {
          exit(path) {
            const body = path.node.body;
            let foundTerminal = false;
            const newBody = [];
            for (const stmt of body) {
              if (foundTerminal) {
                removed++;
                continue;
              }
              if (t.isReturnStatement(stmt) || t.isThrowStatement(stmt) || 
                  t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) {
                foundTerminal = true;
              }
              newBody.push(stmt);
            }
            if (newBody.length < body.length) {
              path.node.body = newBody;
            }

            // Unwrap "bare" blocks left over from collapsing if(true)/if(false)
            // statements (or already present as unnecessary braces) when it's
            // safe to splice their statements into the parent: only when the
            // parent is itself a statement list (Program/BlockStatement) and
            // the block contains no block-scoped bindings that depend on the
            // extra scope (let/const/class/function declarations).
            const parent = path.parent;
            if (t.isProgram(parent) || t.isBlockStatement(parent)) {
              const hasBlockScoped = path.node.body.some(stmt =>
                t.isFunctionDeclaration(stmt) ||
                t.isClassDeclaration(stmt) ||
                (t.isVariableDeclaration(stmt) && stmt.kind !== 'var')
              );
              if (!hasBlockScoped) {
                if (path.node.body.length === 0) {
                  path.remove();
                  removed++;
                } else {
                  path.replaceWithMultiple(path.node.body);
                  removed++;
                }
              }
            }
          }
        }
      });
      
      if (removed > 0) {
        log('Removed ' + removed + ' dead code nodes');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 5: UNUSED DECLARATION REMOVAL
  // Strips decoder/array declarations that become dead once their call sites
  // have already been replaced with literal values by earlier passes.
  // ════════════════════════════════════════════════════════════════════════════

  const unusedDeclarationPass = {
    id: 'unusedDeclarations',
    name: 'Unused Declaration Removal',
    priority: 6,
    enabled: true,
    run(ast, { log }) {
      let removed = 0;
      let changed = true;
      let iterations = 0;

      // Only ever touch obfuscator-style scaffolding names (e.g. _0x3c4d),
      // never arbitrary program variables — a variable a human named and
      // simply doesn't happen to read again later is not "dead code" and
      // must not be deleted by a deobfuscator.
      const isObfuscatorName = (name) => /^_0x[0-9a-f]+$/i.test(name);

      // Iterate to a fixpoint: removing a decoder can make the array (or
      // another helper) newly-unused too.
      while (changed && iterations < 10) {
        changed = false;
        iterations++;

        // Earlier passes replaced reference nodes (e.g. decoder calls) with
        // literals via path.replaceWith, which does not retroactively update
        // the binding info computed at the last scope crawl. Re-crawl so
        // `binding.referenced` reflects the AST as it stands right now.
        traverse(ast, { Program(path) { path.scope.crawl(); } });

        traverse(ast, {
          VariableDeclarator(path) {
            const id = path.node.id;
            const init = path.node.init;
            if (!t.isIdentifier(id) || !init || !isObfuscatorName(id.name)) return;

            // Only remove declarations whose initializer can't have side
            // effects, so we never delete something like `var x = fetch()`.
            const isSafe =
              t.isFunctionExpression(init) || t.isArrowFunctionExpression(init) ||
              t.isArrayExpression(init) || t.isObjectExpression(init) ||
              t.isStringLiteral(init) || t.isNumericLiteral(init) ||
              t.isBooleanLiteral(init) || t.isNullLiteral(init) ||
              t.isIdentifier(init);
            if (!isSafe) return;

            const binding = path.scope.getBinding(id.name);
            if (!binding || binding.referenced || binding.constantViolations.length) return;

            const declPath = path.parentPath;
            if (declPath.isVariableDeclaration() && declPath.node.declarations.length === 1) {
              declPath.remove();
            } else {
              path.remove();
            }
            removed++;
            changed = true;
            log('Removed unused declaration: ' + id.name);
          },
          FunctionDeclaration(path) {
            const id = path.node.id;
            if (!id || !isObfuscatorName(id.name)) return;
            const binding = path.scope.getBinding(id.name);
            if (!binding || binding.referenced) return;
            path.remove();
            removed++;
            changed = true;
            log('Removed unused function: ' + id.name);
          }
        });
      }

      if (removed > 0) {
        log('Removed ' + removed + ' unused declarations');
      } else {
        log('No unused declarations found');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PASS 6: CONSTANT FOLDING
  // ════════════════════════════════════════════════════════════════════════════

  const constantFoldingPass = {
    id: 'constantFolding',
    name: 'Constant Folding',
    priority: 5,
    enabled: true,
    run(ast, { log }) {
      let folded = 0;
      
      traverse(ast, {
        BinaryExpression: {
          exit(path) {
            const op = path.node.operator;
            const left = path.node.left;
            const right = path.node.right;
            
            // Fold numeric operations
            if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
              let result;
              switch(op) {
                case '+': result = left.value + right.value; break;
                case '-': result = left.value - right.value; break;
                case '*': result = left.value * right.value; break;
                case '/': result = left.value / right.value; break;
                case '%': result = left.value % right.value; break;
                case '==': result = left.value == right.value; break;
                case '===': result = left.value === right.value; break;
                case '!=': result = left.value != right.value; break;
                case '!==': result = left.value !== right.value; break;
                case '>': result = left.value > right.value; break;
                case '>=': result = left.value >= right.value; break;
                case '<': result = left.value < right.value; break;
                case '<=': result = left.value <= right.value; break;
                default: return;
              }
              if (typeof result === 'number' && isFinite(result)) {
                path.replaceWith(t.numericLiteral(result));
                folded++;
              } else if (typeof result === 'boolean') {
                path.replaceWith(t.booleanLiteral(result));
                folded++;
              }
            }
            
            // Fold string concatenation
            if (op === '+' && t.isStringLiteral(left) && t.isStringLiteral(right)) {
              path.replaceWith(t.stringLiteral(left.value + right.value));
              folded++;
            }
          }
        },
        
        ConditionalExpression: {
          exit(path) {
            const test = path.node.test;
            if (t.isBooleanLiteral(test)) {
              path.replaceWith(test.value ? path.node.consequent : path.node.alternate);
              folded++;
            }
          }
        },

        UnaryExpression: {
          exit(path) {
            const op = path.node.operator;
            const arg = path.node.argument;
            
            if (op === '!' && t.isNumericLiteral(arg)) {
              path.replaceWith(t.booleanLiteral(!arg.value));
              folded++;
            }
            if (op === '!' && t.isBooleanLiteral(arg)) {
              path.replaceWith(t.booleanLiteral(!arg.value));
              folded++;
            }
            if (op === '-' && t.isNumericLiteral(arg)) {
              path.replaceWith(t.numericLiteral(-arg.value));
              folded++;
            }
          }
        }
      });
      
      if (folded > 0) {
        log('Folded ' + folded + ' constant expressions');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // REGISTER ALL PASSES
  // ════════════════════════════════════════════════════════════════════════════

  const reg = new TransformRegistry();
  reg.registerAll([
    simpleStringArrayPass,
    complexDecoderPass,
    stringDeobfuscationPass,
    deadCodeRemovalPass,
    constantFoldingPass,
    unusedDeclarationPass,
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
