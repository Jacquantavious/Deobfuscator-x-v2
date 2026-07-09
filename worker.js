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
  // MAIN DEOBFUSCATION PASS - Executes the decoder in a sandbox
  // ════════════════════════════════════════════════════════════════════════════

  const runtimeDecoderPass = {
    id: 'runtimeDecoder',
    name: 'Runtime Decoder Execution',
    priority: 1,
    enabled: true,
    run(ast, { log }) {
      let totalInlined = 0;
      
      // Step 1: Extract all _0x functions and their source code
      const functionSources = new Map();
      const functionBodies = new Map();
      
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id?.name;
          if (name && /^_0x[a-f0-9]+$/i.test(name)) {
            try {
              const src = generate(path.node, { compact: false }).code;
              functionSources.set(name, src);
              functionBodies.set(name, path.node);
            } catch(_) {}
          }
        },
        VariableDeclarator(path) {
          const id = path.node.id;
          const init = path.node.init;
          if (t.isIdentifier(id) && /^_0x[a-f0-9]+$/i.test(id.name) && 
              (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) {
            try {
              const src = generate(path.node, { compact: false }).code;
              functionSources.set(id.name, src);
              functionBodies.set(id.name, init);
            } catch(_) {}
          }
        }
      });
      
      if (functionSources.size === 0) {
        log('No _0x functions found');
        return;
      }
      
      log('Found ' + functionSources.size + ' _0x functions');
      
      // Step 2: Find the string array function
      let arrayFunctionName = null;
      let arrayFunctionSrc = null;
      let stringArray = [];
      
      for (const [name, src] of functionSources) {
        // Check if this function returns an array of strings
        try {
          const fn = new Function('return ' + src + ';')();
          if (typeof fn === 'function') {
            const result = fn();
            if (Array.isArray(result) && result.length > 10 && result.every(s => typeof s === 'string')) {
              arrayFunctionName = name;
              arrayFunctionSrc = src;
              stringArray = result;
              log('Found string array function: ' + name + ' with ' + result.length + ' entries');
              break;
            }
          }
        } catch(_) {}
      }
      
      if (stringArray.length === 0) {
        log('No string array found');
        return;
      }
      
      // Step 3: Find the decoder function
      let decoderName = null;
      let decoderSrc = null;
      
      for (const [name, src] of functionSources) {
        if (name === arrayFunctionName) continue;
        // Check if this function references the array function
        if (src.includes(arrayFunctionName)) {
          decoderName = name;
          decoderSrc = src;
          log('Found decoder function: ' + name);
          break;
        }
      }
      
      if (!decoderName || !decoderSrc) {
        log('No decoder function found');
        return;
      }
      
      // Step 4: Build a sandboxed environment with all _0x functions
      const allFunctions = [];
      for (const [name, src] of functionSources) {
        allFunctions.push(src);
      }
      
      const sandboxCode = allFunctions.join('\n');
      
      // Step 5: Find all calls to the decoder function and replace them
      const callSites = [];
      traverse(ast, {
        CallExpression(path) {
          const callee = path.node.callee;
          if (t.isIdentifier(callee) && callee.name === decoderName) {
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
        }
      });
      
      if (callSites.length === 0) {
        log('No calls to decoder found');
        return;
      }
      
      log('Found ' + callSites.length + ' calls to ' + decoderName);
      
      // Step 6: Evaluate each call site
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
            // Try to resolve the identifier from the scope
            let resolved = false;
            const binding = site.path.scope.getBinding(arg0.name);
            if (binding && binding.path.node.init) {
              const init = binding.path.node.init;
              if (t.isStringLiteral(init)) {
                arg0Value = '"' + init.value + '"';
                resolved = true;
              } else if (t.isNumericLiteral(init)) {
                arg0Value = String(init.value);
                resolved = true;
              }
            }
            if (!resolved) {
              // Try to find it in the surrounding code
              let found = false;
              traverse(ast, {
                VariableDeclarator(path) {
                  if (t.isIdentifier(path.node.id) && path.node.id.name === arg0.name && path.node.init) {
                    if (t.isStringLiteral(path.node.init)) {
                      arg0Value = '"' + path.node.init.value + '"';
                      found = true;
                    } else if (t.isNumericLiteral(path.node.init)) {
                      arg0Value = String(path.node.init.value);
                      found = true;
                    }
                  }
                }
              });
              if (!found) continue;
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
          
          // Build the evaluation code
          const evalCode = `
            (function() {
              ${sandboxCode}
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
            
            // Try to decode if it's still obfuscated
            // Check for Base64
            if (/^[A-Za-z0-9+/]+={0,2}$/.test(decoded) && decoded.length > 4) {
              try {
                const b64 = atob(decoded);
                if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(b64) || b64.includes(' ') || b64.includes('.')) {
                  decoded = b64;
                }
              } catch(_) {}
            }
            
            // Check for hex
            if (/^[0-9a-fA-F]{4,}$/.test(decoded) && decoded.length % 2 === 0) {
              try {
                let hex = '';
                for (let i = 0; i < decoded.length; i += 2) {
                  hex += String.fromCharCode(parseInt(decoded.substr(i, 2), 16));
                }
                if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(hex) || hex.includes(' ')) {
                  decoded = hex;
                }
              } catch(_) {}
            }
            
            // Check for URL encoding
            if (decoded.includes('%')) {
              try {
                const url = decodeURIComponent(decoded);
                if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(url) || url.includes(' ')) {
                  decoded = url;
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
      
      totalInlined = evaluated;
      
      // Step 7: Remove unused functions
      if (totalInlined > 0) {
        // Check if array function is still referenced
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
              }
            },
            VariableDeclarator(path) {
              if (t.isIdentifier(path.node.id) && path.node.id.name === arrayFunctionName) {
                if (path.parentPath.node.declarations.length === 1) {
                  path.parentPath.remove();
                } else {
                  path.remove();
                }
              }
            }
          });
          log('Removed unused array function: ' + arrayFunctionName);
        }
        
        // Check if decoder function is still referenced
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
              }
            },
            VariableDeclarator(path) {
              if (t.isIdentifier(path.node.id) && path.node.id.name === decoderName) {
                if (path.parentPath.node.declarations.length === 1) {
                  path.parentPath.remove();
                } else {
                  path.remove();
                }
              }
            }
          });
          log('Removed unused decoder function: ' + decoderName);
        }
        
        // Remove other unused _0x functions
        const usedNames = new Set();
        traverse(ast, {
          Identifier(path) {
            if (/^_0x[a-f0-9]+$/i.test(path.node.name)) {
              usedNames.add(path.node.name);
            }
          }
        });
        
        for (const [name] of functionSources) {
          if (!usedNames.has(name) && name !== arrayFunctionName && name !== decoderName) {
            traverse(ast, {
              FunctionDeclaration(path) {
                if (path.node.id?.name === name) {
                  path.remove();
                }
              },
              VariableDeclarator(path) {
                if (t.isIdentifier(path.node.id) && path.node.id.name === name) {
                  if (path.parentPath.node.declarations.length === 1) {
                    path.parentPath.remove();
                  } else {
                    path.remove();
                  }
                }
              }
            });
          }
        }
        
        log('Inlined ' + totalInlined + ' decoder calls');
      } else {
        log('Failed to evaluate any decoder calls');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // INFINITE LOOP REMOVAL
  // ════════════════════════════════════════════════════════════════════════════

  const infiniteLoopRemovalPass = {
    id: 'infiniteLoopRemoval',
    name: 'Infinite Loop Removal',
    priority: 2,
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
          
          // Check if the body has any effect
          let hasEffect = false;
          for (const stmt of body.body) {
            if (t.isDebuggerStatement(stmt)) continue;
            if (t.isExpressionStatement(stmt) && 
                t.isCallExpression(stmt.expression) &&
                t.isIdentifier(stmt.expression.callee, { name: 'debugger' })) continue;
            // Check if it's just a try/catch with no effect
            if (t.isTryStatement(stmt)) {
              // Check if the try block just has array push/shift
              let isShuffle = true;
              for (const s of stmt.block.body) {
                if (!t.isExpressionStatement(s) || !t.isCallExpression(s.expression)) {
                  isShuffle = false;
                  break;
                }
                const callee = s.expression.callee;
                if (!t.isMemberExpression(callee) || 
                    !t.isIdentifier(callee.object) ||
                    !t.isIdentifier(callee.property) ||
                    (callee.property.name !== 'push' && callee.property.name !== 'shift')) {
                  isShuffle = false;
                  break;
                }
              }
              if (isShuffle) continue;
            }
            hasEffect = true;
            break;
          }
          
          if (!hasEffect) {
            path.remove();
            removed++;
          }
        },
        
        // Remove IIFE with while(true)
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
              if (isTrue) {
                // Check if the while body is just array shuffle
                const wbody = stmt.body;
                if (t.isBlockStatement(wbody)) {
                  let isShuffle = true;
                  for (const s of wbody.body) {
                    if (!t.isTryStatement(s)) {
                      isShuffle = false;
                      break;
                    }
                    // Check try block for array push/shift
                    let hasPush = false;
                    for (const ts of s.block.body) {
                      if (t.isExpressionStatement(ts) && t.isCallExpression(ts.expression)) {
                        const callee2 = ts.expression.callee;
                        if (t.isMemberExpression(callee2) && 
                            t.isIdentifier(callee2.property) &&
                            (callee2.property.name === 'push' || callee2.property.name === 'shift')) {
                          hasPush = true;
                        }
                      }
                    }
                    if (!hasPush) {
                      isShuffle = false;
                      break;
                    }
                  }
                  if (isShuffle) continue;
                }
                hasOnlyInfiniteLoop = false;
                break;
              }
            }
            if (!t.isEmptyStatement(stmt) && !t.isDebuggerStatement(stmt)) {
              hasOnlyInfiniteLoop = false;
              break;
            }
          }
          
          if (hasOnlyInfiniteLoop) {
            path.remove();
            removed++;
          }
        }
      });
      
      if (removed > 0) {
        log('Removed ' + removed + ' infinite loop(s)');
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // REGISTER ALL PASSES
  // ════════════════════════════════════════════════════════════════════════════

  const reg = new TransformRegistry();
  reg.registerAll([
    runtimeDecoderPass,
    infiniteLoopRemovalPass,
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
