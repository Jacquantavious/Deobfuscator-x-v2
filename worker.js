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
  // DEOBFUSCATION PASS - Actually runs the decoder in a sandbox
  // ════════════════════════════════════════════════════════════════════════════

  const deobfuscatorPass = {
    id: 'deobfuscator',
    name: 'JavaScript Obfuscator Deobfuscator',
    priority: 1,
    enabled: true,
    run(ast, { log }) {
      let decodedCount = 0;
      let stringArray = [];
      let arrayFunctionName = null;
      let decoderName = null;
      
      // ── Step 1: Find the string array function (_0x642e) ──
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

      // ── Step 2: Find the decoder function (_0x4684) ──
      let decoderSource = '';
      
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id?.name;
          if (!name || !/^_0x[a-f0-9]+$/i.test(name) || name === arrayFunctionName) return;

          const body = path.node.body;
          if (!t.isBlockStatement(body)) return;

          // Check if this function references the array
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
            try {
              decoderSource = generate(path.node, { compact: false }).code;
              log('Found decoder: ' + name);
            } catch(_) {}
          }
        }
      });

      if (!decoderName || !decoderSource) {
        log('No decoder function found');
        return;
      }

      // ── Step 3: Build a sandbox with the decoder and array function ──
      let arraySource = '';
      traverse(ast, {
        FunctionDeclaration(path) {
          if (path.node.id?.name === arrayFunctionName) {
            try {
              arraySource = generate(path.node, { compact: false }).code;
            } catch(_) {}
          }
        }
      });

      if (!arraySource) {
        log('Failed to extract array source');
        return;
      }

      // ── Step 4: Decode each string using the actual decoder ──
      const decodedMap = new Map();
      
      // Build the sandbox code - this will execute the decoder with each index
      for (let i = 0; i < stringArray.length; i++) {
        try {
          // The decoder expects an index like '0x7a' (hex string)
          const hexIndex = '0x' + (i + 108).toString(16);
          
          const evalCode = `
            (function() {
              ${arraySource}
              ${decoderSource}
              // The decoder stores decoded strings in a cache
              // We need to call it with the hex index
              return ${decoderName}("${hexIndex}");
            })()
          `;
          
          let result;
          try {
            result = new Function('return ' + evalCode)();
          } catch(_) {
            // Try with the raw index
            try {
              const evalCode2 = `
                (function() {
                  ${arraySource}
                  ${decoderSource}
                  return ${decoderName}(${i + 108});
                })()
              `;
              result = new Function('return ' + evalCode2)();
            } catch(_2) {
              continue;
            }
          }
          
          if (typeof result === 'string' && result.length > 0) {
            // The result might still be encoded - try to decode it
            let decoded = result;
            
            // Check for URL encoding
            if (decoded.includes('%')) {
              try {
                const urlDecoded = decodeURIComponent(decoded);
                if (urlDecoded.length > 0 && urlDecoded !== decoded) {
                  decoded = urlDecoded;
                }
              } catch(_) {}
            }
            
            // Check for escaped sequences
            if (decoded.includes('\\x')) {
              try {
                const unescaped = eval('"' + decoded + '"');
                if (unescaped.length > 0 && unescaped !== decoded) {
                  decoded = unescaped;
                }
              } catch(_) {}
            }
            
            decodedMap.set(stringArray[i], decoded);
          }
        } catch(_) {
          // Skip this string if it can't be decoded
        }
      }

      log('Decoded ' + decodedMap.size + ' strings');

      // ── Step 5: Replace all decoder calls with decoded strings ──
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

      log('Found ' + callSites.length + ' calls to ' + decoderName);

      for (const site of callSites) {
        try {
          const arg = site.args[0];
          let idx = null;
          
          if (t.isStringLiteral(arg)) {
            const val = arg.value;
            if (val.startsWith('0x')) {
              idx = parseInt(val, 16) - 108;
            } else {
              idx = parseInt(val, 16) - 108;
            }
          } else if (t.isNumericLiteral(arg)) {
            idx = arg.value - 108;
          }

          if (idx !== null && idx >= 0 && idx < stringArray.length) {
            const original = stringArray[idx];
            const decoded = decodedMap.get(original);
            if (decoded) {
              site.path.replaceWith(t.stringLiteral(decoded));
              decodedCount++;
            }
          }
        } catch(_) {
          // Skip if can't decode
        }
      }

      // ── Step 6: Replace direct array accesses ──
      traverse(ast, {
        MemberExpression(path) {
          const obj = path.node.object;
          const prop = path.node.property;
          
          if (!t.isIdentifier(obj)) return;
          if (obj.name !== arrayFunctionName) return;
          
          if (t.isNumericLiteral(prop) || t.isStringLiteral(prop)) {
            let idx = null;
            if (t.isNumericLiteral(prop)) {
              idx = prop.value;
            } else if (t.isStringLiteral(prop)) {
              idx = parseInt(prop.value, 10);
            }
            
            if (idx !== null && idx >= 0 && idx < stringArray.length) {
              const original = stringArray[idx];
              const decoded = decodedMap.get(original);
              if (decoded) {
                path.replaceWith(t.stringLiteral(decoded));
                decodedCount++;
              }
            }
          }
        }
      });

      // ── Step 7: Remove unused functions ──
      if (decodedCount > 0) {
        traverse(ast, {
          FunctionDeclaration(path) {
            const name = path.node.id?.name;
            if (name === arrayFunctionName || name === decoderName) {
              let refs = 0;
              const targetName = name;
              traverse(ast, {
                Identifier(p) {
                  if (p.node.name === targetName && p.parentPath !== path) {
                    refs++;
                  }
                }
              });
              if (refs === 0) {
                path.remove();
                log('Removed function: ' + name);
              }
            }
          }
        });

        log('Decoded ' + decodedCount + ' strings');
      } else {
        log('Failed to decode any strings - trying alternative approach');
        
        // ── Alternative: Try to decode using a simpler method ──
        // Some strings might be directly Base64 encoded without the decoder
        let altDecoded = 0;
        for (const str of stringArray) {
          try {
            // Try Base64 decoding
            const b64 = atob(str);
            if (b64 && b64.length > 0 && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(b64)) {
              decodedMap.set(str, b64);
              altDecoded++;
            }
          } catch(_) {}
        }
        
        if (altDecoded > 0) {
          log('Alternative decoding found ' + altDecoded + ' strings');
          // Re-run the replacement with the alternative decoded strings
          for (const site of callSites) {
            try {
              const arg = site.args[0];
              let idx = null;
              
              if (t.isStringLiteral(arg)) {
                const val = arg.value;
                if (val.startsWith('0x')) {
                  idx = parseInt(val, 16) - 108;
                }
              } else if (t.isNumericLiteral(arg)) {
                idx = arg.value - 108;
              }

              if (idx !== null && idx >= 0 && idx < stringArray.length) {
                const original = stringArray[idx];
                const decoded = decodedMap.get(original);
                if (decoded) {
                  site.path.replaceWith(t.stringLiteral(decoded));
                  decodedCount++;
                }
              }
            } catch(_) {}
          }
          log('Decoded ' + decodedCount + ' total strings');
        }
      }
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // REGISTER ALL PASSES
  // ════════════════════════════════════════════════════════════════════════════

  const reg = new TransformRegistry();
  reg.registerAll([
    deobfuscatorPass,
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
