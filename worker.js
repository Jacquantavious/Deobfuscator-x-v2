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
  // DEOBFUSCATION PASS - Properly decodes the obfuscated strings
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
      const decoderOffset = 108; // Hardcoded from the obfuscated code
      
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

      // ── Step 2: Decode each string ──
      // The strings are hex-encoded Base64. We need to:
      // 1. Convert hex to bytes
      // 2. Base64 decode
      // 3. Then URL decode
  
      function hexToBytes(hex) {
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
          bytes.push(parseInt(hex.substr(i, 2), 16));
        }
        return bytes;
      }

      function base64Decode(str) {
        try {
          return atob(str);
        } catch(_) {
          return null;
        }
      }

      function urlDecode(str) {
        try {
          return decodeURIComponent(str);
        } catch(_) {
          return null;
        }
      }

      const decodedMap = new Map();

      for (const str of stringArray) {
        let decoded = str;
        
        try {
          // Step 1: Hex decode
          const bytes = hexToBytes(str);
          let hexDecoded = '';
          for (const b of bytes) {
            hexDecoded += String.fromCharCode(b);
          }
          
          // Step 2: Base64 decode
          const base64Decoded = base64Decode(hexDecoded);
          if (base64Decoded) {
            // Step 3: URL decode
            const urlDecoded = urlDecode(base64Decoded);
            if (urlDecoded && urlDecoded.length > 0) {
              decoded = urlDecoded;
            } else {
              decoded = base64Decoded;
            }
          }
        } catch(_) {
          // If decoding fails, keep the original
        }
        
        // If it's still just hex-looking, try to decode as hex directly
        if (decoded === str && /^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0) {
          try {
            let hexStr = '';
            for (let i = 0; i < str.length; i += 2) {
              hexStr += String.fromCharCode(parseInt(str.substr(i, 2), 16));
            }
            if (hexStr.length > 0 && /[a-zA-Z]/.test(hexStr)) {
              decoded = hexStr;
            }
          } catch(_) {}
        }
        
        decodedMap.set(str, decoded);
      }

      log('Decoded ' + decodedMap.size + ' strings');

      // ── Step 3: Find the decoder function (_0x4684) ──
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
            log('Found decoder: ' + name);
          }
        }
      });

      if (!decoderName) {
        log('No decoder function found');
        return;
      }

      // ── Step 4: Replace all decoder calls with decoded strings ──
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
        } catch(_) {
          // Skip if can't decode
        }
      }

      // ── Step 5: Replace direct array accesses ──
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
              if (decoded && decoded !== original) {
                path.replaceWith(t.stringLiteral(decoded));
                decodedCount++;
              }
            }
          }
        }
      });

      // ── Step 6: Remove the decoder and array functions ──
      if (decodedCount > 0) {
        // Remove the array function
        traverse(ast, {
          FunctionDeclaration(path) {
            const name = path.node.id?.name;
            if (name === arrayFunctionName) {
              let refs = 0;
              traverse(ast, {
                Identifier(p) {
                  if (p.node.name === name && p.parentPath !== path) {
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
        
        // Remove the decoder function
        traverse(ast, {
          FunctionDeclaration(path) {
            const name = path.node.id?.name;
            if (name === decoderName) {
              let refs = 0;
              traverse(ast, {
                Identifier(p) {
                  if (p.node.name === name && p.parentPath !== path) {
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
        log('Failed to decode any strings');
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
