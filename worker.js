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
    const stmt = body[0];
    if (!t.isReturnStatement(stmt)) return null;
    const ret = stmt.argument;
    if (!t.isCallExpression(ret) || !isFromCharCode(ret.callee) || ret.arguments.length !== 1) return null;
    const arg = ret.arguments[0];
    if (!t.isBinaryExpression(arg) || (arg.operator !== '+' && arg.operator !== '-')) return null;
    const param = fn.params[0];
    if (!t.isIdentifier(param)) return null;
    const pn = param.name;
    let shift = null;
    if (t.isIdentifier(arg.left) && arg.left.name === pn && t.isNumericLiteral(arg.right)) shift = arg.operator === '+' ? arg.right.value : -arg.right.value;
    else if (t.isIdentifier(arg.right) && arg.right.name === pn && t.isNumericLiteral(arg.left)) shift = arg.operator === '+' ? arg.left.value : 0;
    if (shift === null) return null;
    return { decode: n => { try { return String.fromCharCode(n + shift); } catch(_) { return null; } } };
  }
  function detectNibbleDecoder(fn) {
    if (!fn?.body) return false;
    const s = JSON.stringify(fn.body);
    return s.includes('parseInt') && s.includes('16') && s.includes('fromCharCode') && s.includes('substr');
  }
  function unpackHexString(str) {
    if (str.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(str)) return null;
    try { let r = ''; for (let i = 0; i < str.length; i += 2) r += String.fromCharCode(parseInt(str.substr(i, 2), 16)); return r; } catch(_) { return null; }
  }

  const stringDecoderPass = {
    id: 'stringDecoder', name: 'String Decoder Reconstruction', priority: 7, enabled: true,
    run(ast, { log }) {
      let decoded = 0;
      traverse(ast, {
        CallExpression(path2) {
          if (!isFromCharCode(path2.node.callee)) return;
          const args = path2.node.arguments;
          if (args.length === 0) return;
          const codes = args.map(a => t.isNumericLiteral(a) ? a.value : null);
          if (codes.some(c => c === null)) return;
          try { const str = String.fromCharCode(...codes); if (isPrintable(str)) { path2.replaceWith(t.stringLiteral(str)); decoded++; } } catch(_) {}
        },
      });
      const shiftDecoders = new Map();
      traverse(ast, {
        FunctionDeclaration(path2) { const i = detectShiftDecoder(path2.node); if (i) shiftDecoders.set(path2.node.id?.name, i); },
        VariableDeclarator(path2) { if (!path2.node.init) return; const i = detectShiftDecoder(path2.node.init); if (i && t.isIdentifier(path2.node.id)) shiftDecoders.set(path2.node.id.name, i); },
      });
      if (shiftDecoders.size > 0) {
        traverse(ast, {
          CallExpression(path2) {
            if (!t.isIdentifier(path2.node.callee)) return;
            const info = shiftDecoders.get(path2.node.callee.name);
            if (!info || path2.node.arguments.length !== 1) return;
            const arg = path2.node.arguments[0];
            if (!t.isNumericLiteral(arg)) return;
            const r = info.decode(arg.value);
            if (r !== null && isPrintable(r)) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
          },
        });
      }
      const nibbleDecoders = new Map();
      traverse(ast, { FunctionDeclaration(path2) { if (detectNibbleDecoder(path2.node)) nibbleDecoders.set(path2.node.id?.name, 'nibble'); } });
      if (nibbleDecoders.size > 0) {
        traverse(ast, {
          CallExpression(path2) {
            if (!t.isIdentifier(path2.node.callee) || !nibbleDecoders.has(path2.node.callee.name) || path2.node.arguments.length !== 1) return;
            const arg = path2.node.arguments[0];
            if (!t.isStringLiteral(arg)) return;
            const r = unpackHexString(arg.value);
            if (r !== null && isPrintable(r)) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
          },
        });
      }
      traverse(ast, {
        CallExpression(path2) {
          if (!t.isMemberExpression(path2.node.callee) || !t.isIdentifier(path2.node.callee.property, { name: 'join' })) return;
          if (path2.node.arguments.length !== 1 || !t.isStringLiteral(path2.node.arguments[0], { value: '' })) return;
          const obj = path2.node.callee.object;
          if (!t.isArrayExpression(obj)) return;
          const chars = obj.elements.map(el => {
            if (t.isStringLiteral(el) && el.value.length === 1) return el.value;
            if (t.isNumericLiteral(el)) return String.fromCharCode(el.value);
            return null;
          });
          if (chars.some(c => c === null)) return;
          const str = chars.join('');
          if (str.length > 0 && isPrintable(str)) { path2.replaceWith(t.stringLiteral(str)); decoded++; }
        },
      });
      log('String decoder resolved ' + decoded + ' encoded string(s)');
    },
  };

  function extractReturnCall(block) {
    for (const stmt of block.body) { if (t.isReturnStatement(stmt)) return stmt.argument; }
    return null;
  }
  function extractXorKeyFromMapFn(fn) {
    if (!fn) return null;
    let body = null, param = null;
    if (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) { param = fn.params[0]; body = fn.body; }
    else return null;
    let callExpr = t.isBlockStatement(body) ? extractReturnCall(body) : body;
    if (!callExpr || !t.isCallExpression(callExpr) || !isFromCharCode(callExpr.callee)) return null;
    const arg = callExpr.arguments[0];
    if (!t.isBinaryExpression(arg) || arg.operator !== '^') return null;
    const { left, right } = arg; const pn = param?.name;
    if (t.isIdentifier(left) && left.name === pn) {
      if (t.isNumericLiteral(right)) return right.value;
      if (t.isArrayExpression(right)) return right.elements.filter(e => t.isNumericLiteral(e)).map(e => e.value);
    }
    if (t.isIdentifier(right) && right.name === pn && t.isNumericLiteral(left)) return left.value;
    return null;
  }
  function isSplitMapJoinXor(node) {
    if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee) || !t.isIdentifier(node.callee.property, { name: 'join' })) return false;
    const mc = node.callee.object;
    if (!t.isCallExpression(mc) || !t.isMemberExpression(mc.callee) || !t.isIdentifier(mc.callee.property, { name: 'map' })) return false;
    const sc = mc.callee.object;
    if (!t.isCallExpression(sc) || !t.isMemberExpression(sc.callee) || !t.isIdentifier(sc.callee.property, { name: 'split' })) return false;
    return t.isStringLiteral(sc.callee.object);
  }
  function evalSplitMapJoinXor(node) {
    try {
      const mc = node.callee.object; const sc = mc.callee.object;
      const str = sc.callee.object.value; const mapFn = mc.arguments[0];
      let xorKey = null;
      if (t.isArrowFunctionExpression(mapFn) || t.isFunctionExpression(mapFn)) {
        const body = mapFn.body;
        let expr = t.isBlockStatement(body) ? extractReturnCall(body) : body;
        if (expr && t.isCallExpression(expr) && isFromCharCode(expr)) {
          const arg = expr.arguments[0];
          if (t.isBinaryExpression(arg) && arg.operator === '^') {
            if (t.isNumericLiteral(arg.right)) xorKey = arg.right.value;
            if (t.isNumericLiteral(arg.left)) xorKey = arg.left.value;
          }
        }
      }
      if (xorKey === null) return null;
      return str.split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ xorKey)).join('');
    } catch(_) { return null; }
  }
  function detectXorFunction(fn) {
    if (!fn?.body?.body) return null;
    const fnStr = JSON.stringify(fn.body.body);
    if (!fnStr.includes('charCodeAt') || !fnStr.includes('^') || fn.params.length < 2) return null;
    return (str, key) => {
      try { let r = ''; for (let i = 0; i < str.length; i++) r += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length)); return r; } catch(_) { return null; }
    };
  }

  const xorDecodingPass = {
    id: 'xorDecoding', name: 'XOR Decoding', priority: 8, enabled: true,
    run(ast, { log }) {
      let decoded = 0;
      traverse(ast, {
        CallExpression(path2) {
          if (!t.isMemberExpression(path2.node.callee) || !t.isIdentifier(path2.node.callee.property) || path2.node.callee.property.name !== 'join') return;
          if (!path2.node.arguments[0] || !t.isStringLiteral(path2.node.arguments[0], { value: '' })) return;
          const mapCall = path2.node.callee.object;
          if (!t.isCallExpression(mapCall) || !t.isMemberExpression(mapCall.callee) || !t.isIdentifier(mapCall.callee.property, { name: 'map' })) return;
          const arr = mapCall.callee.object;
          if (!t.isArrayExpression(arr)) return;
          const bytes = arr.elements.map(e => t.isNumericLiteral(e) ? e.value : null);
          if (bytes.some(b => b === null)) return;
          const xorKey = extractXorKeyFromMapFn(mapCall.arguments[0]);
          if (xorKey === null) return;
          try {
            let result;
            if (typeof xorKey === 'number') result = bytes.map(b => String.fromCharCode(b ^ xorKey)).join('');
            else if (Array.isArray(xorKey)) result = bytes.map((b,i) => String.fromCharCode(b ^ xorKey[i % xorKey.length])).join('');
            else return;
            path2.replaceWith(t.stringLiteral(result)); decoded++;
          } catch(_) {}
        },
      });
      traverse(ast, {
        CallExpression(path2) {
          if (!isSplitMapJoinXor(path2.node)) return;
          const r = evalSplitMapJoinXor(path2.node);
          if (r !== null) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
        },
      });
      const xorFunctions = new Map();
      traverse(ast, {
        FunctionDeclaration(path2) { const fn = detectXorFunction(path2.node); if (fn) xorFunctions.set(path2.node.id?.name, fn); },
        VariableDeclarator(path2) {
          if (!t.isFunctionExpression(path2.node.init) && !t.isArrowFunctionExpression(path2.node.init)) return;
          const fn = detectXorFunction(path2.node.init);
          if (fn && t.isIdentifier(path2.node.id)) xorFunctions.set(path2.node.id.name, fn);
        },
      });
      if (xorFunctions.size > 0) {
        traverse(ast, {
          CallExpression(path2) {
            if (!t.isIdentifier(path2.node.callee)) return;
            const fn = xorFunctions.get(path2.node.callee.name);
            if (!fn) return;
            const args = path2.node.arguments;
            if (args.length < 2 || !t.isStringLiteral(args[0]) || !t.isStringLiteral(args[1])) return;
            const r = fn(args[0].value, args[1].value);
            if (r !== null) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
          },
        });
      }
      log('XOR decoded ' + decoded + ' expression(s)');
    },
  };

  function needsNormalization(name) {
    if (!name) return false;
    if (/[^\x00-\x7F]/.test(name)) return true;
    if (/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/.test(name)) return true;
    if (/[\uFE00-\uFE0F]/.test(name)) return true;
    if (/[\u0300-\u036F\u1DC0-\u1DFF\u20D0-\u20FF]/.test(name)) return true;
    return false;
  }
  // Shared homoglyph map used by normalizeStr and extendedUnicodeNormPass
  const HOMOGLYPH_MAP = { '\u0430':'a','\u0435':'e','\u043E':'o','\u0440':'p','\u0441':'c','\u0443':'y','\u0445':'x','\u0410':'A','\u0412':'B','\u0415':'E','\u041A':'K','\u041C':'M','\u041D':'H','\u041E':'O','\u0420':'P','\u0421':'C','\u0422':'T','\u0425':'X','\u03B1':'a','\u03B2':'b','\u03B5':'e','\u03BF':'o','\u03BD':'v','\u03BA':'k','\u0391':'A','\u0392':'B','\u0395':'E','\u039A':'K','\u039C':'M','\u039D':'N','\u039F':'O','\u03A1':'P','\u03A4':'T','\u03A5':'Y','\u03A7':'X' };
  function normalizeStr(str) {
    // Fast path: pure ASCII strings need no normalization whatsoever
    if (!/[^\x00-\x7F]/.test(str)) return str;
    let r = str.normalize('NFKD');
    r = r.replace(/[\u0300-\u036F]/g, '');
    r = r.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFFD]/g, '');
    r = r.replace(/[\uFE00-\uFE0F]/g, '');
    let out = '';
    for (const ch of r) out += HOMOGLYPH_MAP[ch] ?? ch;
    return out;
  }

  const homoglyphCleanupPass = {
    id: 'homoglyphCleanup', name: 'Homoglyph & Unicode Identifier Cleanup', priority: 9, enabled: true,
    run(ast, { log }) {
      let normalized = 0;
      const renameMap = new Map();
      const counters = {};
      function getNewName(original, hint = 'var') {
        if (renameMap.has(original)) return renameMap.get(original);
        const base = hint.replace(/[^a-z]/g, '') || 'var';
        counters[base] = (counters[base] || 0) + 1;
        const n = base + '_' + counters[base];
        renameMap.set(original, n);
        return n;
      }
      // Cache normalizeStr results per unique string value — the same obfuscated
      // string can appear thousands of times in a minified file; compute once.
      const strNormCache = new Map();
      traverse(ast, {
        StringLiteral(path2) {
          const v = path2.node.value;
          // Fast path: skip strings that are already pure ASCII
          if (!/[^\x00-\x7F]/.test(v)) return;
          let n = strNormCache.get(v);
          if (n === undefined) { n = normalizeStr(v); strNormCache.set(v, n); }
          if (n !== v) path2.replaceWith(t.stringLiteral(n));
        },
      });
      traverse(ast, {
        FunctionDeclaration(path2) {
          const id = path2.node.id;
          if (id && needsNormalization(id.name)) { try { path2.scope.rename(id.name, getNewName(id.name, 'func')); normalized++; } catch(_) {} }
        },
        VariableDeclarator(path2) {
          const id = path2.node.id;
          if (t.isIdentifier(id) && needsNormalization(id.name)) { try { path2.scope.rename(id.name, getNewName(id.name, 'var')); normalized++; } catch(_) {} }
        },
      });
      log('Normalized ' + normalized + ' unicode identifier(s)');
    },
  };

  const unicodeNormalizationPass = {
    id: 'unicodeNormalization', name: 'Unicode Normalization', priority: 10, enabled: true,
    run(ast, { log }) {
      let count = 0;
      traverse(ast, {
        StringLiteral(path2) {
          const raw = path2.node.extra?.raw;
          // raw is the quoted source text, e.g. '\u0068\u006f' — single backslash before u.
          // The old regex /\\\\u/ wrongly required TWO backslashes. Fixed to /\\u/.
          if (!raw || !/\\[ux][0-9a-fA-F]/i.test(raw)) return;
          // Babel already decoded the value; just emit a clean string literal.
          const decoded = path2.node.value;
          const n = t.stringLiteral(decoded);
          path2.replaceWith(n); count++;
        },
        TemplateLiteral(path2) {
          path2.node.quasis.forEach(quasi => {
            const raw = quasi.value.raw;
            if (!raw || !/\\[ux][0-9a-fA-F]/i.test(raw)) return;
            quasi.value.raw = quasi.value.cooked ?? raw; count++;
          });
        },
      });
      if (count > 0) log('Decoded ' + count + ' unicode escape(s)');
    },
  };

  const hexDeobfuscationPass = {
    id: 'hexDeobfuscation', name: 'Hex Deobfuscation', priority: 12, enabled: true,
    run(ast, { log }) {
      let hexCount = 0, octCount = 0, binCount = 0;
      traverse(ast, {
        NumericLiteral(path2) {
          const raw = path2.node.extra?.raw;
          if (!raw) return;
          if (/^0[xX][0-9a-fA-F]+$/.test(raw)) { path2.node.extra = { raw: String(path2.node.value), rawValue: path2.node.value }; hexCount++; return; }
          if (/^0[oO][0-7]+$/.test(raw)) { path2.node.extra = { raw: String(path2.node.value), rawValue: path2.node.value }; octCount++; return; }
          if (/^0[bB][01]+$/.test(raw)) { path2.node.extra = { raw: String(path2.node.value), rawValue: path2.node.value }; binCount++; return; }
        },
      });
      const parts = [];
      if (hexCount) parts.push(hexCount + ' hex');
      if (octCount) parts.push(octCount + ' octal');
      if (binCount) parts.push(binCount + ' binary');
      if (parts.length) log('Normalized ' + parts.join(', ') + ' literal(s)');
    },
  };

  const templateLiteralPass = {
    id: 'templateLiteral', name: 'Template Literal Collapse', priority: 13, enabled: true,
    run(ast, { log }) {
      let collapsed = 0;
      traverse(ast, {
        TemplateLiteral(path2) {
          const { quasis, expressions } = path2.node;
          const allStatic = expressions.every(e => t.isStringLiteral(e) || t.isNumericLiteral(e) || t.isBooleanLiteral(e));
          if (!allStatic) return;
          let result = '';
          for (let i = 0; i < quasis.length; i++) {
            result += quasis[i].value.cooked ?? quasis[i].value.raw;
            if (i < expressions.length) result += String(expressions[i].value);
          }
          path2.replaceWith(t.stringLiteral(result)); collapsed++;
        },
        BinaryExpression: { exit(path2) {
          if (path2.node.operator !== '+') return;
          const { left, right } = path2.node;
          if (t.isStringLiteral(left) && t.isStringLiteral(right)) { path2.replaceWith(t.stringLiteral(left.value + right.value)); collapsed++; }
        }},
      });
      if (collapsed > 0) log('Collapsed ' + collapsed + ' template literal(s)/string concat(s)');
    },
  };

  function extractNumericBW(node) {
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) return -node.argument.value;
    if (t.isUnaryExpression(node) && node.operator === '~' && t.isNumericLiteral(node.argument)) return ~node.argument.value;
    return null;
  }
  function makeNum(val) { if (val < 0) return t.unaryExpression('-', t.numericLiteral(-val)); return t.numericLiteral(val); }
  function simplifyIdentity(path2, op, left, right, lv, rv) {
    if (op === '^' && rv === 0) { path2.replaceWith(left); return; }
    if (op === '^' && lv === 0) { path2.replaceWith(right); return; }
    if (op === '|' && rv === 0 && t.isNumericLiteral(left)) { path2.replaceWith(t.numericLiteral(left.value | 0)); return; }
    if (op === '|' && lv === 0 && t.isNumericLiteral(right)) { path2.replaceWith(t.numericLiteral(right.value | 0)); return; }
    if (op === '&' && rv === -1) { path2.replaceWith(left); return; }
    if (op === '&' && lv === -1) { path2.replaceWith(right); return; }
    if (op === '>>>' && rv === 0 && t.isNumericLiteral(left) && left.value >= 0) { path2.replaceWith(left); return; }
    if (op === '<<' && rv === 0 && t.isNumericLiteral(left)) { path2.replaceWith(left); return; }
    if (op === '>>' && rv === 0 && t.isNumericLiteral(left)) { path2.replaceWith(left); return; }
  }

  const bitwiseSimplifyPass = {
    id: 'bitwiseSimplify', name: 'Bitwise / Rotation Simplification', priority: 15, enabled: true,
    run(ast, { log }) {
      let simplified = 0;
      traverse(ast, {
        UnaryExpression: { exit(path2) {
          if (path2.node.operator !== '~' || !t.isNumericLiteral(path2.node.argument)) return;
          path2.replaceWith(makeNum(~path2.node.argument.value)); simplified++;
        }},
        BinaryExpression: { exit(path2) {
          const { operator: op, left, right } = path2.node;
          const lv = extractNumericBW(left), rv = extractNumericBW(right);
          if (lv === null || rv === null) { simplifyIdentity(path2, op, left, right, lv, rv); return; }
          let result = null;
          switch(op) {
            case '&': result = (lv & rv) >>> 0; break; case '|': result = (lv | rv) >>> 0; break;
            case '^': result = (lv ^ rv) >>> 0; break; case '<<': result = (lv << rv) >>> 0; break;
            case '>>': result = lv >> rv; break; case '>>>': result = lv >>> rv; break; default: return;
          }
          if (result === null || Math.abs(result) > 0x7fffffff) return;
          path2.replaceWith(makeNum(result)); simplified++;
        }},
      });
      log('Simplified ' + simplified + ' bitwise expression(s)');
    },
  };

  const SAFE_OPS = new Set(['+','-','*','/','%','**','|','&','^','<<','>>','>>>']);
  const numericLiteralPass = {
    id: 'numericLiterals', name: 'Numeric Literal Normalization', priority: 16, enabled: true,
    run(ast, { log }) {
      let folded = 0;
      traverse(ast, {
        BinaryExpression: { exit(path2) {
          if (!SAFE_OPS.has(path2.node.operator)) return;
          const { left, right } = path2.node;
          if (!t.isNumericLiteral(left) || !t.isNumericLiteral(right)) return;
          let result;
          try { result = new Function('return (' + left.value + ' ' + path2.node.operator + ' ' + right.value + ')')(); } catch(_) { return; }
          if (typeof result !== 'number' || !isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) return;
          path2.replaceWith(t.numericLiteral(result)); folded++;
        }},
        UnaryExpression: { exit(path2) {
          const op = path2.node.operator;
          if (op !== '-' && op !== '+' && op !== '~') return;
          const arg = path2.node.argument;
          if (!t.isNumericLiteral(arg)) return;
          const val = arg.value;
          let result = op === '-' ? -val : op === '+' ? +val : ~val;
          if (typeof result !== 'number' || !isFinite(result)) return;
          path2.replaceWith(t.numericLiteral(result)); folded++;
        }},
      });
      if (folded > 0) log('Folded ' + folded + ' constant numeric expression(s)');
    },
  };

  const RESERVED = new Set(['break','case','catch','class','const','continue','debugger','default','delete','do','else','export','extends','finally','for','function','if','import','in','instanceof','let','new','return','static','super','switch','this','throw','try','typeof','var','void','while','with','yield','enum','null','true','false','await','async']);
  const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
  const propertyAccessNormPass = {
    id: 'propertyAccessNorm', name: 'Property Access Normalization', priority: 17, enabled: true,
    run(ast, { log }) {
      let converted = 0;
      traverse(ast, {
        MemberExpression(path2) {
          if (!path2.node.computed) return;
          const prop = path2.node.property;
          if (!t.isStringLiteral(prop)) return;
          const key = prop.value;
          if (!VALID_IDENT.test(key) || RESERVED.has(key)) return;
          path2.node.computed = false;
          path2.node.property = t.identifier(key);
          converted++;
        },
      });
      if (converted > 0) log('Normalized ' + converted + ' bracket accessor(s) to dot notation');
    },
  };

  function resolveOrderArray(path2, varName) {
    let searchPath = path2.parentPath;
    while (searchPath) {
      if (searchPath.node?.body) {
        const body = Array.isArray(searchPath.node.body) ? searchPath.node.body : (searchPath.node.body?.body || []);
        for (const stmt of (Array.isArray(body) ? body : [])) {
          if (!t.isVariableDeclaration(stmt)) continue;
          for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id) || decl.id.name !== varName) continue;
            if (t.isArrayExpression(decl.init)) return decl.init.elements.filter(e => t.isStringLiteral(e)||t.isNumericLiteral(e)).map(e => String(e.value));
            if (t.isCallExpression(decl.init)) {
              const call = decl.init;
              if (t.isMemberExpression(call.callee) && t.isStringLiteral(call.callee.object) && t.isIdentifier(call.callee.property) && call.callee.property.name === 'split' && t.isStringLiteral(call.arguments[0]))
                return call.callee.object.value.split(call.arguments[0].value);
            }
          }
        }
      }
      searchPath = searchPath.parentPath;
    }
    return null;
  }
  function tryStringSplitPattern(path2) {
    const body = path2.node.body.body;
    let sw = null;
    for (const s of body) { if (t.isSwitchStatement(s)) { sw = s; break; } }
    if (!sw || !t.isMemberExpression(sw.discriminant) || !t.isIdentifier(sw.discriminant.object)) return null;
    const varName = sw.discriminant.object.name;
    const orderArray = resolveOrderArray(path2, varName);
    if (!orderArray || orderArray.length === 0) return null;
    const caseMap = new Map();
    for (const c of sw.cases) {
      if (!c.test) continue;
      const key = t.isStringLiteral(c.test) ? c.test.value : t.isNumericLiteral(c.test) ? String(c.test.value) : null;
      if (key === null) continue;
      caseMap.set(key, c.consequent.filter(s => !t.isContinueStatement(s) && !t.isBreakStatement(s)));
    }
    if (caseMap.size === 0) return null;
    const result = [];
    for (const key of orderArray) { const stmts = caseMap.get(key); if (stmts) result.push(...stmts); }
    return result.length > 0 ? result : null;
  }
  function tryNumericStatePattern(path2) {
    const body = path2.node.body.body;
    let sw = null;
    for (const s of body) { if (t.isSwitchStatement(s)) { sw = s; break; } }
    if (!sw || !t.isIdentifier(sw.discriminant)) return null;
    const stateVarName = sw.discriminant.name;
    let initialState = null;
    const parent = path2.parentPath;
    if (parent) {
      try {
        parent.traverse({
          VariableDeclarator(vPath) {
            if (t.isIdentifier(vPath.node.id) && vPath.node.id.name === stateVarName && t.isNumericLiteral(vPath.node.init)) initialState = vPath.node.init.value;
          },
        });
      } catch(_) {}
    }
    if (initialState === null) return null;
    const stateMap = new Map();
    for (const c of sw.cases) {
      if (!c.test || !t.isNumericLiteral(c.test)) continue;
      const stmts = [], pn = c.test.value;
      let nextState = null;
      for (const stmt of c.consequent) {
        if (t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) continue;
        if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression) && t.isIdentifier(stmt.expression.left) && stmt.expression.left.name === stateVarName && t.isNumericLiteral(stmt.expression.right)) { nextState = stmt.expression.right.value; continue; }
        stmts.push(stmt);
      }
      stateMap.set(pn, { stmts, nextState });
    }
    if (stateMap.size === 0) return null;
    const result = []; const visited = new Set(); let current = initialState;
    while (current !== null && stateMap.has(current) && !visited.has(current)) {
      visited.add(current); const { stmts, nextState } = stateMap.get(current);
      result.push(...stmts); current = nextState;
    }
    return result.length > 0 ? result : null;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // ADVANCED CONTROL FLOW RECOVERY
  //
  // Handles all four loop wrapper variants:
  //   while(true){switch(state){…}}
  //   for(;;){switch(state){…}}
  //   do{switch(state){…}}while(…)
  //   while(1){switch(state){…}}
  //
  // Builds a mini Control-Flow Graph from the switch cases, then walks it in
  // topological order to emit structured if/else-if/else, for, while, do-while,
  // break, continue, and return statements wherever the pattern is recognisable.
  // Falls back to flat statement splicing when the graph is too irregular.
  //
  // After replacement the dispatcher variable and its initialiser declaration
  // are deleted from the surrounding scope.
  // ══════════════════════════════════════════════════════════════════════════════

  // ── Helper: is this loop "forever"? ──────────────────────────────────────────
  function isForeverLoop(node) {
    if (t.isWhileStatement(node)) {
      const test = node.test;
      return t.isBooleanLiteral(test, { value: true }) ||
             t.isNumericLiteral(test, { value: 1 }) ||
             (t.isUnaryExpression(test) && test.operator === '!' && t.isNumericLiteral(test.argument, { value: 0 }));
    }
    if (t.isForStatement(node)) return !node.init && !node.test && !node.update;
    if (t.isDoWhileStatement(node)) {
      const test = node.test;
      return t.isBooleanLiteral(test, { value: true }) || t.isNumericLiteral(test, { value: 1 });
    }
    return false;
  }

  // ── Helper: extract the body block from any loop ──────────────────────────────
  function loopBody(node) {
    const body = node.body;
    return t.isBlockStatement(body) ? body : null;
  }

  // ── Helper: resolve the state-variable name and initial literal value ─────────
  function resolveStateVar(switchDiscriminant) {
    if (t.isIdentifier(switchDiscriminant)) return { name: switchDiscriminant.name, kind: 'numeric' };
    if (t.isMemberExpression(switchDiscriminant) && t.isIdentifier(switchDiscriminant.object))
      return { name: switchDiscriminant.object.name, kind: 'array' };
    return null;
  }

  // ── Helper: find the initialiser value for a variable in the surrounding scope –
  function findInitValue(stateVarName, loopPath) {
    // Walk ancestor scopes looking for var/let/const decls or prior assignments
    let search = loopPath.parentPath;
    while (search) {
      const node = search.node;
      const stmts = t.isBlockStatement(node) ? node.body
                  : t.isProgram(node)        ? node.body
                  : node.body && Array.isArray(node.body.body) ? node.body.body
                  : null;
      if (stmts) {
        for (const stmt of stmts) {
          if (t.isVariableDeclaration(stmt)) {
            for (const decl of stmt.declarations) {
              if (!t.isIdentifier(decl.id) || decl.id.name !== stateVarName) continue;
              if (t.isNumericLiteral(decl.init)) return decl.init.value;
              if (t.isStringLiteral(decl.init)) return decl.init.value;
            }
          }
        }
      }
      search = search.parentPath;
    }
    return null;
  }

  // ── Helper: extract the literal case key ─────────────────────────────────────
  function caseKey(switchCase) {
    if (!switchCase.test) return '__default__';
    if (t.isNumericLiteral(switchCase.test)) return switchCase.test.value;
    if (t.isStringLiteral(switchCase.test)) return switchCase.test.value;
    return null;
  }

  // ── Helper: find what state transition (if any) a set of stmts performs ──────
  //   Returns { kind: 'assign'|'return'|'break'|'continue'|'none', value }
  function extractTransition(stmts, stateVarName) {
    for (let i = stmts.length - 1; i >= 0; i--) {
      const s = stmts[i];
      if (t.isReturnStatement(s)) return { kind: 'return', value: s.argument ?? null };
      if (t.isBreakStatement(s) && !s.label) return { kind: 'break' };
      if (t.isContinueStatement(s) && !s.label) return { kind: 'continue' };
      if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression)) {
        const { left, right, operator } = s.expression;
        if (operator === '=' && t.isIdentifier(left) && left.name === stateVarName) {
          const v = t.isNumericLiteral(right) ? right.value
                  : t.isStringLiteral(right)  ? right.value
                  : null;
          if (v !== null) return { kind: 'assign', value: v };
        }
      }
    }
    return { kind: 'none' };
  }

  // ── Helper: recursive transition-TREE extractor ───────────────────────────────
  // Unlike extractTransition (which only looks at the trailing statement of a
  // flat list), this walks into IfStatements so that a case body like:
  //
  //   if (cond) { state = 3; } else { state = 7; }
  //
  // is recognised as a *branch* node carrying two independent successors,
  // rather than being missed entirely (the old code only ever saw the
  // top-level statement list, found an IfStatement instead of a trailing
  // assignment/return, and fell back to `{ kind: 'none' }`, silently
  // dropping the branch).
  //
  // Returns a small tree:
  //   leaf:   { kind: 'assign'|'return'|'break'|'continue'|'none', value? }
  //   branch: { kind: 'branch', test, consequent: <tree>, alternate: <tree> }
  //
  // `prefix` collects the non-transition statements encountered before the
  // branch point so the caller can emit them ahead of the reconstructed
  // if/else. Statements *inside* each arm are intentionally left untouched
  // here (the structurer re-derives them from the original consequent /
  // alternate blocks) — extractTransitionsDeep only needs to know *where*
  // control goes, not duplicate the statement bodies.
  function extractTransitionsDeep(stmts, stateVarName) {
    // Find the first IfStatement that is the LAST meaningful statement of
    // this list (i.e. nothing after it but the implicit fallthrough) AND
    // whose branches are themselves fully resolvable to transitions. If no
    // such branch point exists, fall back to the flat extractTransition.
    for (let i = stmts.length - 1; i >= 0; i--) {
      const s = stmts[i];
      // Once we hit a leaf transition before finding an IfStatement, stop —
      // the flat extractor already covers this case correctly.
      if (t.isReturnStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s)) break;
      if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression)) {
        const { left, operator } = s.expression;
        if (operator === '=' && t.isIdentifier(left) && left.name === stateVarName) break;
      }
      if (t.isIfStatement(s)) {
        // Only treat this as a structurable branch if it's the LAST
        // statement in the list (no statements after the if/else that
        // would execute unconditionally regardless of which arm ran).
        if (i !== stmts.length - 1) continue;
        const consBlock = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
        const altBlock = s.alternate ? (t.isBlockStatement(s.alternate) ? s.alternate.body : [s.alternate]) : [];
        const consTrans = extractTransitionsDeep(consBlock, stateVarName);
        const altTrans = s.alternate ? extractTransitionsDeep(altBlock, stateVarName) : { kind: 'none' };
        // Both arms must resolve to *some* recognisable transition (even
        // 'none' is fine — it just means that arm falls through with no
        // explicit jump) for this to be worth structuring as if/else.
        return { kind: 'branch', test: s.test, consequent: consTrans, alternate: altTrans, consBlock, altBlock };
      }
    }
    return extractTransition(stmts, stateVarName);
  }

  // ── Helper: strip control-transfer + state assignments from statement list ────
  function stripTransfer(stmts, stateVarName) {
    return stmts.filter(s => {
      if (t.isBreakStatement(s) || t.isContinueStatement(s)) return false;
      // A ReturnStatement is itself a transition leaf (handled separately by
      // extractTransition/extractTransitionsDeep + re-emitted by the caller
      // as a fresh `return` node) — keeping it here as well would duplicate
      // it in the output.
      if (t.isReturnStatement(s)) return false;
      if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression)) {
        const { left, operator } = s.expression;
        if (operator === '=' && t.isIdentifier(left) && left.name === stateVarName) return false;
      }
      return true;
    });
  }

  // ── Helper: remove state-var declaration(s) from the block surrounding the loop
  function removeStateVarDecl(loopPath, stateVarName) {
    let search = loopPath.parentPath;
    while (search) {
      const node = search.node;
      const stmts = t.isBlockStatement(node) ? node.body
                  : t.isProgram(node)         ? node.body
                  : null;
      if (stmts) {
        for (let i = stmts.length - 1; i >= 0; i--) {
          const stmt = stmts[i];
          if (!t.isVariableDeclaration(stmt)) continue;
          stmt.declarations = stmt.declarations.filter(d => !(t.isIdentifier(d.id) && d.id.name === stateVarName));
          if (stmt.declarations.length === 0) stmts.splice(i, 1);
        }
        break; // only strip from the immediately enclosing block
      }
      search = search.parentPath;
    }
  }

  // ── CFG node ─────────────────────────────────────────────────────────────────
  class CfgNode {
    constructor(id, stmts) { this.id = id; this.stmts = stmts; this.succs = []; /* [{cond, target}] */ }
  }

  // ── Build a CFG from the switch cases of a numeric/string state machine ───────
  function buildCFG(switchNode, stateVarName, initialState) {
    const nodes = new Map();   // key → CfgNode
    const order = [];

    for (const swCase of switchNode.cases) {
      const key = caseKey(swCase);
      if (key === null) continue;
      const allStmts = swCase.consequent.filter(s => !t.isBreakStatement(s) && !t.isContinueStatement(s));
      const node = new CfgNode(key, allStmts);
      // Store the full transition TREE (may be a 'branch' node) rather than
      // only the trailing transition — this is what allows if/else recovery
      // for cases whose body ends in a conditional jump to two different
      // states instead of a single unconditional one.
      node.trans = extractTransitionsDeep(allStmts, stateVarName);
      nodes.set(key, node);
      order.push(key);
    }

    // Wire up successor edges (used only for reachability / back-edge
    // detection — the actual statements are re-derived from node.trans
    // during emission so branch arms aren't lost).
    function collectTargets(trans, out) {
      if (!trans) return;
      if (trans.kind === 'assign') out.push(trans.value);
      else if (trans.kind === 'return') out.push('__return__');
      else if (trans.kind === 'branch') { collectTargets(trans.consequent, out); collectTargets(trans.alternate, out); }
    }
    for (const [, node] of nodes) {
      const targets = [];
      collectTargets(node.trans, targets);
      for (const tgt of targets) node.succs.push({ cond: null, target: tgt });
    }

    return { nodes, order, initialState };
  }

  // ── Emit structured statements from a CFG (if/else + loop recovery) ──────────
  //
  // This is a small Relooper-style structurer:
  //
  //   emitFrom(key, activePath)
  //     - activePath is the stack of node keys whose emission is currently
  //       "in progress" (an ancestor chain, innermost last). If `key`
  //       reappears in activePath, that's a genuine back-edge: the state
  //       machine jumps back to a node whose body we are still in the
  //       middle of emitting, i.e. a loop. We emit a `continue` right here
  //       at the detection site (this is the exact point in the nested
  //       if/else tree where the jump-back happens) and tag the result with
  //       `backEdge: key` so it bubbles up unchanged through every
  //       intermediate frame (assign-chains and branch arms alike) until it
  //       reaches the one frame whose own key equals `backEdge` — that
  //       frame, and only that frame, wraps its emitted body in
  //       `while (true) { ... }`. The old code's `visited` Set just
  //       silently dropped the jump and the statements behind it, which is
  //       a correctness bug — those statements really do execute again on
  //       every loop iteration in the original program.
  function cfgToStatements(cfg, stateVarName) {
    const { nodes, order, initialState } = cfg;
    const MAX_NODES_PER_RUN = 4096; // guard against pathological/cyclic metadata
    let emitBudget = MAX_NODES_PER_RUN;
    // Tracks every node key that has ever been emitted by ANY emitFrom call
    // (whether at the top level or nested inside a branch/loop). This is
    // distinct from `activePath` (which only tracks the current ancestor
    // chain for back-edge detection) — without this set, the final
    // "unreachable nodes" sweep below would re-emit nodes that are already
    // nested inside an if/else or while body from an earlier top-level
    // entry point, duplicating their statements in the output.
    const globallyEmitted = new Set();

    // Render the literal (non-transition) statements of a node's body.
    function nodeBodyStmts(node) {
      // node.trans may be a 'branch' — in that case the trailing IfStatement
      // itself is the transition and must NOT be included verbatim (we
      // rebuild it from the branch tree instead). For non-branch nodes the
      // transition is a single trailing statement already excluded by
      // stripTransfer.
      if (node.trans.kind === 'branch') {
        // Every statement except the trailing IfStatement.
        return stripTransfer(node.stmts.slice(0, -1), stateVarName);
      }
      return stripTransfer(node.stmts, stateVarName);
    }

    // Resolve a transition (leaf or branch) into { stmts, backEdge }.
    // backEdge is null, or the key of the ancestor node (somewhere in the
    // current activePath) that some arm jumped back to — this value is
    // produced exactly once, at the leaf detection site inside emitFrom,
    // and simply forwarded unchanged through every intermediate assign/
    // branch frame above it. A `continue` statement is already present in
    // `stmts` at the correct nested position by the time backEdge is set;
    // intermediate frames never need to (and must not) inject their own.
    function emitTransition(trans, activePath) {
      if (--emitBudget < 0) return { stmts: [], backEdge: null };
      switch (trans.kind) {
        case 'return':
          return { stmts: [t.returnStatement(trans.value ?? null)], backEdge: null };
        case 'break':
        case 'continue':
        case 'none':
          return { stmts: [], backEdge: null };
        case 'assign':
          return emitFrom(trans.value, activePath);
        case 'branch': {
          const consSub = emitTransition(trans.consequent, activePath);
          const altSub = trans.alternate ? emitTransition(trans.alternate, activePath) : { stmts: [], backEdge: null };
          const consLeading = stripTransfer(trans.consBlock, stateVarName);
          const altLeading = trans.altBlock ? stripTransfer(trans.altBlock, stateVarName) : [];
          const consBody = [...consLeading, ...consSub.stmts];
          const altBody = [...altLeading, ...altSub.stmts];
          const ifStmt = t.ifStatement(
            trans.test,
            t.blockStatement(consBody),
            altBody.length > 0 ? t.blockStatement(altBody) : null
          );
          // At most one arm of a well-formed loop condition normally loops
          // back; if (in pathological input) both did, prefer the
          // consequent's target — the other is still structurally valid,
          // just nested one level deeper than a minimal structuring would
          // place it, which doesn't affect correctness.
          const backEdge = consSub.backEdge ?? altSub.backEdge ?? null;
          return { stmts: [ifStmt], backEdge };
        }
        default:
          return { stmts: [], backEdge: null };
      }
    }

    // Emit a node and everything reachable from it in sequence, given the
    // activePath of ancestor keys currently mid-emission.
    function emitFrom(key, activePath) {
      if (--emitBudget < 0) return { stmts: [], backEdge: null };
      if (key === null || key === undefined || key === '__return__') return { stmts: [], backEdge: null };
      if (activePath.includes(key)) {
        // Genuine back-edge, detected at the exact point of the jump: emit
        // `continue` right here (it will end up correctly nested inside
        // whichever if/else arm caused the jump, since this return value
        // flows straight up through emitTransition's branch case above)
        // and tag it so the ancestor frame for `key` knows to wrap itself.
        return { stmts: [t.continueStatement()], backEdge: key };
      }
      const node = nodes.get(key);
      if (!node) return { stmts: [], backEdge: null };
      globallyEmitted.add(key);

      const bodyStmts = nodeBodyStmts(node);
      const transResult = emitTransition(node.trans, [...activePath, key]);
      const combinedStmts = [...bodyStmts, ...transResult.stmts];

      if (transResult.backEdge === key) {
        // This frame is the loop header the back-edge targeted: wrap the
        // fully-assembled body (which already contains a correctly-nested
        // `continue` at the jump site) in `while (true) { ... }`.
        const whileNode = t.whileStatement(t.booleanLiteral(true), t.blockStatement(combinedStmts));
        return { stmts: [whileNode], backEdge: null };
      }
      // Either no back-edge occurred, or it targets an ancestor further up
      // activePath — either way, just forward it unchanged.
      return { stmts: combinedStmts, backEdge: transResult.backEdge };
    }

    const result = [];
    function runFrom(key) {
      if (key === null || key === undefined || key === '__return__' || globallyEmitted.has(key)) return;
      const { stmts } = emitFrom(key, []);
      result.push(...stmts);
    }

    runFrom(initialState);
    // Emit any unreachable nodes too (they may still matter for fallthrough logic).
    for (const key of order) runFrom(key);

    return result;
  }

  // ── Main numeric state-machine recovery ──────────────────────────────────────
  function tryFullCFGRecovery(loopPath) {
    const body = loopBody(loopPath.node);
    if (!body) return null;

    // Find the switch statement (optionally wrapped in a single block)
    let sw = null;
    for (const s of body.body) {
      if (t.isSwitchStatement(s)) { sw = s; break; }
      if (t.isBlockStatement(s)) {
        for (const s2 of s.body) { if (t.isSwitchStatement(s2)) { sw = s2; break; } }
        if (sw) break;
      }
    }
    if (!sw) return null;

    const stateInfo = resolveStateVar(sw.discriminant);
    if (!stateInfo) return null;
    const { name: stateVarName, kind } = stateInfo;

    // Try to find initial value
    const initVal = findInitValue(stateVarName, loopPath);

    if (kind === 'numeric' && initVal !== null && typeof initVal === 'number') {
      const cfg = buildCFG(sw, stateVarName, initVal);
      if (cfg.nodes.size === 0) return null;
      const stmts = cfgToStatements(cfg, stateVarName);
      if (stmts.length > 0) {
        removeStateVarDecl(loopPath, stateVarName);
        return stmts;
      }
    }

    if (kind === 'array') {
      // string-split order array pattern
      const r = tryStringSplitPattern(loopPath);
      if (r) { removeStateVarDecl(loopPath, stateVarName); return r; }
    }

    if (kind === 'numeric') {
      // Fallback: original linear numeric-state walk (handles string-keyed states too)
      const r = tryNumericStatePattern(loopPath);
      if (r) { removeStateVarDecl(loopPath, stateVarName); return r; }
    }

    if (kind === 'numeric' && initVal !== null && typeof initVal === 'string') {
      // String-keyed numeric-style state machine
      const r = tryNumericStatePattern(loopPath);
      if (r) { removeStateVarDecl(loopPath, stateVarName); return r; }
    }

    return null;
  }

  const controlFlowPass = {
    id: 'controlFlow', name: 'Control Flow Reconstruction', priority: 22, enabled: true,
    run(ast, { log }) {
      let recovered = 0;

      function handleLoopPath(path2) {
        if (!isForeverLoop(path2.node)) return;
        const result = tryFullCFGRecovery(path2);
        if (result && result.length > 0) {
          try { path2.replaceWithMultiple(result); recovered++; } catch(_) {}
        }
      }

      traverse(ast, {
        WhileStatement: handleLoopPath,
        ForStatement:   handleLoopPath,
        DoWhileStatement: handleLoopPath,
      });

      log('Recovered ' + recovered + ' control flow block(s)');
    },
  };

  function isRotationIIFE(call, fn) {
    if (call.arguments.length !== 2) return false;
    if (!t.isBlockStatement(fn.body)) return false;
    const s = JSON.stringify(fn.body);
    return (s.includes('push') && s.includes('shift')) || s.includes('rotate');
  }

  const rotateSimplificationPass = {
    id: 'rotateSimplifcation', name: 'Rotate Simplification', priority: 25, enabled: true,
    run(ast, { log }) {
      let removed = 0;
      traverse(ast, {
        ExpressionStatement(path2) {
          const expr = path2.node.expression;
          if (!t.isCallExpression(expr)) return;
          const callee = expr.callee;
          if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return;
          if (!isRotationIIFE(expr, callee)) return;
          path2.remove(); removed++;
        },
      });
      traverse(ast, {
        TryStatement(path2) {
          if (!path2.node.block) return;
          const s = JSON.stringify(path2.node.block);
          if (s.includes('push') && s.includes('shift') && s.includes('parseInt')) { path2.remove(); removed++; }
        },
      });
      log('Removed ' + removed + ' rotation pattern(s)');
    },
  };

  const commaSplitterPass = {
    id: 'commaSplitter', name: 'Comma Sequence Splitter', priority: 28, enabled: true,
    run(ast, { log }) {
      let split = 0;
      traverse(ast, {
        ExpressionStatement(path2) {
          const expr = path2.node.expression;
          if (!t.isSequenceExpression(expr) || expr.expressions.length < 2) return;
          path2.replaceWithMultiple(expr.expressions.map(e => t.expressionStatement(e)));
          split += expr.expressions.length - 1;
        },
        VariableDeclaration(path2) {
          const extras = [];
          for (const decl of path2.node.declarations) {
            if (!t.isSequenceExpression(decl.init) || decl.init.expressions.length < 2) continue;
            const exprs = decl.init.expressions;
            extras.push(...exprs.slice(0,-1).map(e => t.expressionStatement(e)));
            decl.init = exprs[exprs.length - 1];
            split += exprs.length - 1;
          }
          if (extras.length > 0) path2.insertBefore(extras);
        },
      });
      if (split > 0) log('Split ' + split + ' comma-sequence expression(s) into statements');
    },
  };

  function ternaryDepth(node, d = 0) {
    if (!t.isConditionalExpression(node)) return d;
    return Math.max(ternaryDepth(node.consequent, d+1), ternaryDepth(node.alternate, d+1));
  }
  function buildIfElse(node) {
    if (!t.isConditionalExpression(node)) return t.expressionStatement(node);
    const consequent = t.isBlockStatement(node.consequent) ? node.consequent : t.blockStatement([t.isConditionalExpression(node.consequent) ? buildIfElse(node.consequent) : t.expressionStatement(node.consequent)]);
    const alternate = t.isConditionalExpression(node.alternate) ? buildIfElse(node.alternate) : t.blockStatement([t.expressionStatement(node.alternate)]);
    return t.ifStatement(node.test, consequent, alternate);
  }

  const ternaryUnfoldPass = {
    id: 'ternaryUnfold', name: 'Ternary Unfold', priority: 32, enabled: true,
    run(ast, { log }) {
      let unfolded = 0;
      traverse(ast, {
        ExpressionStatement(path2) {
          const expr = path2.node.expression;
          if (!t.isConditionalExpression(expr) || ternaryDepth(expr) < 2) return;
          const ifStmt = buildIfElse(expr);
          if (ifStmt) { path2.replaceWith(ifStmt); unfolded++; }
        },
      });
      if (unfolded > 0) log('Unfolded ' + unfolded + ' nested ternary expression(s) to if/else');
    },
  };

  function getLiteralTruth(node) {
    if (!node) return null;
    if (node.type === 'BooleanLiteral') return node.value;
    if (node.type === 'NumericLiteral') return node.value !== 0;
    if (node.type === 'StringLiteral') return node.value !== '';
    if (node.type === 'NullLiteral') return false;
    if (node.type === 'Identifier' && node.name === 'undefined') return false;
    // Fold constant binary comparisons: 1==1, 0===0, 1!==0, etc.
    if (node.type === 'BinaryExpression') {
      const lv = getLiteralTruth(node.left);
      const rv = getLiteralTruth(node.right);
      // Only fold when both sides are pure literals (not expressions that may have side effects)
      const leftIsLiteral = node.left && ['BooleanLiteral','NumericLiteral','StringLiteral','NullLiteral'].includes(node.left.type);
      const rightIsLiteral = node.right && ['BooleanLiteral','NumericLiteral','StringLiteral','NullLiteral'].includes(node.right.type);
      if (!leftIsLiteral || !rightIsLiteral) return null;
      const l = node.left.value ?? null;
      const r = node.right.value ?? null;
      switch (node.operator) {
        case '==':  return l == r;   // eslint-disable-line eqeqeq
        case '!=':  return l != r;   // eslint-disable-line eqeqeq
        case '===': return l === r;
        case '!==': return l !== r;
        case '>':   return l > r;
        case '>=':  return l >= r;
        case '<':   return l < r;
        case '<=':  return l <= r;
        default:    return null;
      }
    }
    return null;
  }

  const deadCodePass = {
    id: 'deadCode', name: 'Dead Code Removal', priority: 45, enabled: true,
    run(ast, { log }) {
      let removed = 0;
      traverse(ast, {
        IfStatement: { exit(path2) {
          const tv = getLiteralTruth(path2.node.test);
          if (tv === null) return;
          if (tv === true) { if (t.isBlockStatement(path2.node.consequent)) path2.replaceWithMultiple(path2.node.consequent.body); else path2.replaceWith(path2.node.consequent); }
          else { if (path2.node.alternate) { if (t.isBlockStatement(path2.node.alternate)) path2.replaceWithMultiple(path2.node.alternate.body); else path2.replaceWith(path2.node.alternate); } else path2.remove(); }
          removed++;
        }},
        WhileStatement(path2) { if (getLiteralTruth(path2.node.test) === false) { path2.remove(); removed++; } },
        ExpressionStatement(path2) {
          const expr = path2.node.expression;
          if (t.isUnaryExpression(expr) && expr.operator === 'void' && t.isNumericLiteral(expr.argument) && expr.argument.value === 0) { path2.remove(); removed++; return; }
          if (t.isBooleanLiteral(expr) || t.isNullLiteral(expr) || (t.isIdentifier(expr) && expr.name === 'undefined') || t.isNumericLiteral(expr)) { path2.remove(); removed++; }
        },
        BlockStatement: { exit(path2) {
          const body = path2.node.body;
          let ti = -1;
          for (let i = 0; i < body.length; i++) {
            const s = body[i];
            if (t.isReturnStatement(s) || t.isThrowStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s)) { ti = i; break; }
          }
          if (ti !== -1 && ti < body.length - 1) { removed += body.length - ti - 1; path2.node.body = body.slice(0, ti + 1); }
        }},
      });
      if (removed > 0) log('Removed ' + removed + ' dead code node(s)');
    },
  };

  const astSimplificationPass = {
    id: 'astSimplification', name: 'AST Simplification', priority: 60, enabled: true,
    run(ast, { log }) {
      let simplified = 0;
      traverse(ast, {
        ConditionalExpression: { exit(path2) {
          const tv = getLiteralTruth(path2.node.test);
          if (tv === null) return;
          path2.replaceWith(tv ? path2.node.consequent : path2.node.alternate); simplified++;
        }},
        LogicalExpression: { exit(path2) {
          const { operator: op, left, right } = path2.node;
          const lv = getLiteralTruth(left);
          if (lv === null) return;
          if (op === '&&') { path2.replaceWith(lv === false ? left : right); simplified++; }
          else if (op === '||') { path2.replaceWith(lv === true ? left : right); simplified++; }
          else if (op === '??') { if (t.isNullLiteral(left) || (t.isIdentifier(left) && left.name === 'undefined')) { path2.replaceWith(right); simplified++; } }
        }},
        BlockStatement: { exit(path2) {
          const parent = path2.parent;
          if (!t.isBlockStatement(parent) && !t.isProgram(parent)) return;
          if (path2.node.body.length === 0) { path2.remove(); simplified++; }
        }},
        ExpressionStatement: { exit(path2) {
          if (!t.isSequenceExpression(path2.node.expression)) return;
          const exprs = path2.node.expression.expressions;
          if (exprs.length <= 1) { if (exprs.length === 1) { path2.replaceWith(t.expressionStatement(exprs[0])); simplified++; } return; }
          path2.replaceWithMultiple(exprs.map(e => t.expressionStatement(e))); simplified++;
        }},
      });
      if (simplified > 0) log('Simplified ' + simplified + ' expression(s)');
    },
  };

  function isDebuggerOnlyFunction(node) {
    if (!t.isFunctionExpression(node) && !t.isArrowFunctionExpression(node)) return false;
    const body = node.body;
    if (!t.isBlockStatement(body) || body.body.length === 0) return false;
    return body.body.every(s => t.isDebuggerStatement(s) || (t.isExpressionStatement(s) && t.isStringLiteral(s.expression)));
  }
  function isDebuggerOnlyBlock(node) {
    if (t.isDebuggerStatement(node)) return true;
    if (t.isBlockStatement(node)) return node.body.length > 0 && node.body.every(s => t.isDebuggerStatement(s));
    return false;
  }

  const antiDebuggerPass = {
    id: 'antiDebugger', name: 'Anti-Debugger Removal', priority: 80, enabled: true,
    run(ast, { log }) {
      let removed = 0;
      traverse(ast, {
        DebuggerStatement(path2) { path2.remove(); removed++; },
        CallExpression(path2) {
          const { callee, arguments: args } = path2.node;
          if (t.isIdentifier(callee) && callee.name === 'eval' && args.length === 1 && t.isStringLiteral(args[0]) && args[0].value.trim() === 'debugger') { path2.replaceWith(t.identifier('undefined')); removed++; return; }
          if (t.isIdentifier(callee) && (callee.name === 'setInterval' || callee.name === 'setTimeout') && args.length >= 1 && isDebuggerOnlyFunction(args[0])) { path2.replaceWith(t.numericLiteral(0)); removed++; }
        },
        WhileStatement(path2) {
          const test = path2.node.test;
          const isInfinite = (t.isBooleanLiteral(test) && test.value === true) || (t.isNumericLiteral(test) && test.value === 1);
          if (isInfinite && isDebuggerOnlyBlock(path2.node.body)) { path2.remove(); removed++; }
        },
        ForStatement(path2) {
          if (path2.node.init || path2.node.test || path2.node.update) return;
          if (isDebuggerOnlyBlock(path2.node.body)) { path2.remove(); removed++; }
        },
      });
      if (removed > 0) log('Removed ' + removed + ' anti-debugger construct(s)');
    },
  };

  function isNoopFunction(node) {
    if (!t.isFunctionExpression(node) && !t.isArrowFunctionExpression(node)) return false;
    const body = node.body;
    if (t.isBlockStatement(body)) return body.body.length === 0 || (body.body.length === 1 && t.isReturnStatement(body.body[0]) && (body.body[0].argument == null || t.isIdentifier(body.body[0].argument, { name: 'undefined' })));
    return t.isIdentifier(body, { name: 'undefined' }) || (t.isUnaryExpression(body) && body.operator === 'void');
  }
  function isBodyAllDebuggerEnhanced(node) {
    if (!node) return false;
    if (t.isDebuggerStatement(node)) return true;
    if (t.isBlockStatement(node)) return node.body.length > 0 && node.body.every(s => t.isDebuggerStatement(s) || (t.isExpressionStatement(s) && t.isStringLiteral(s.expression)));
    return false;
  }
  function isTimingTrap(node) {
    if (!t.isBinaryExpression(node) || (node.operator !== '>' && node.operator !== '>=')) return false;
    const left = node.left;
    if (!t.isBinaryExpression(left) || left.operator !== '-') return false;
    const isTimeCall = n => t.isCallExpression(n) && t.isMemberExpression(n.callee) && (t.isIdentifier(n.callee.property, { name: 'now' }) || t.isIdentifier(n.callee.property, { name: 'getTime' }));
    return isTimeCall(left.left) || isTimeCall(left.right);
  }
  function isDevtoolsSize(node) {
    if (!t.isBinaryExpression(node) || (node.operator !== '>' && node.operator !== '>=')) return false;
    const left = node.left;
    if (!t.isBinaryExpression(left) || left.operator !== '-') return false;
    const isWindowDim = n => t.isMemberExpression(n) && ['outerWidth','outerHeight','innerWidth','innerHeight'].includes(n.property?.name);
    return isWindowDim(left.left) || isWindowDim(left.right);
  }

  const antiDebuggerEnhancedPass = {
    id: 'antiDebuggerEnhanced', name: 'Anti-Debugger Enhanced', priority: 81, enabled: true,
    run(ast, { log }) {
      let removed = 0;
      traverse(ast, {
        AssignmentExpression(path2) {
          const { left, right } = path2.node;
          if (t.isMemberExpression(left) && t.isIdentifier(left.object, { name: 'console' }) && isNoopFunction(right)) { if (path2.parentPath.isExpressionStatement()) { path2.parentPath.remove(); removed++; return; } }
          if (t.isMemberExpression(left) && t.isIdentifier(left.property, { name: 'console' }) && (t.isObjectExpression(right) || t.isNullLiteral(right))) { if (path2.parentPath.isExpressionStatement()) { path2.parentPath.remove(); removed++; } }
        },
        CallExpression(path2) {
          const { callee, arguments: args } = path2.node;
          if (t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: 'Object' }) && t.isIdentifier(callee.property, { name: 'defineProperty' }) && args.length >= 2 && t.isIdentifier(args[0], { name: 'console' })) { if (path2.parentPath.isExpressionStatement()) { path2.parentPath.remove(); removed++; return; } }
          if (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: 'toString' }) && args.length === 0) {
            const parent = path2.parentPath;
            if (parent.isBinaryExpression()) { const gp = parent.parentPath; if (gp.isIfStatement() && isBodyAllDebuggerEnhanced(gp.node.consequent)) { gp.remove(); removed++; return; } }
          }
        },
        IfStatement(path2) {
          if (!isBodyAllDebuggerEnhanced(path2.node.consequent)) return;
          if (isTimingTrap(path2.node.test) || isDevtoolsSize(path2.node.test)) { path2.remove(); removed++; }
        },
        TryStatement(path2) {
          const allNodes = [...(path2.node.block?.body??[]), ...(path2.node.handler?.body?.body??[]), ...(path2.node.finalizer?.body??[])];
          if (allNodes.some(s => t.isDebuggerStatement(s)) && allNodes.every(s => t.isDebuggerStatement(s) || (t.isExpressionStatement(s) && t.isStringLiteral(s.expression)))) { path2.remove(); removed++; }
        },
      });
      if (removed > 0) log('Removed ' + removed + ' enhanced anti-debug pattern(s)');
      else log('No enhanced anti-debug patterns found');
    },
  };

  const GLOBALS_SET = new Set(['undefined','null','true','false','NaN','Infinity','arguments','eval','parseInt','parseFloat','isNaN','isFinite','Object','Array','Function','String','Number','Boolean','Symbol','BigInt','RegExp','Error','TypeError','Map','Set','WeakMap','WeakSet','Promise','Proxy','Reflect','JSON','Math','Date','console','window','document','globalThis','self','location','navigator','setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','fetch','XMLHttpRequest','WebSocket','localStorage','sessionStorage','alert','confirm','prompt','module','exports','require','process']);
  const GARBLED_RE = /^(?:_0x[a-fA-F0-9]+|[a-zA-Z][a-fA-F0-9]{3,}|_[a-zA-Z0-9]{1,2}[a-fA-F0-9]{2,})$/;
  const SHORT_VAR_RE = /^[a-zA-Z]$/;
  function isGarbled(name) { if (GLOBALS_SET.has(name)) return false; if (GARBLED_RE.test(name)) return true; if (SHORT_VAR_RE.test(name)) return true; return false; }

  const scopeRenamePass = {
    id: 'scopeRename', name: 'Scope-Aware Variable Rename', priority: 90, enabled: false,
    run(ast, { log }) {
      let totalRenamed = 0;
      const processScope = (scopePath) => {
        const bindings = scopePath.scope?.bindings ?? {};
        const renames = new Map(); let vi = 0, fi = 0;
        for (const [name, binding] of Object.entries(bindings)) {
          if (!isGarbled(name)) continue;
          const kind = binding.kind;
          let newName;
          if (kind === 'hoisted' || binding.path.isFunctionDeclaration?.() || (binding.path.isVariableDeclarator?.() && (binding.path.get('init').isFunctionExpression?.() || binding.path.get('init').isArrowFunctionExpression?.())))
            newName = '_fn' + (fi++);
          else if (kind === 'param') newName = '_p' + (vi++);
          else newName = '_v' + (vi++);
          while (bindings[newName] || renames.has(newName)) { if (newName.startsWith('_fn')) newName = '_fn' + (fi++); else if (newName.startsWith('_p')) newName = '_p' + (vi++); else newName = '_v' + (vi++); }
          renames.set(name, newName);
        }
        for (const [oldName, newName] of renames) { try { scopePath.scope.rename(oldName, newName); totalRenamed++; } catch(_) {} }
      };
      traverse(ast, { Program: processScope, FunctionDeclaration: processScope, FunctionExpression: processScope, ArrowFunctionExpression: processScope });
      if (totalRenamed > 0) log('Renamed ' + totalRenamed + ' garbled identifier(s)');
      else log('No garbled identifiers found to rename');
    },
  };

  // ── Base64 / ROT / Caesar / multi-encoding string decoders ─────────────────
  function tryBase64(s) { try { const d = atob(s); if (isPrintable(d)) return d; } catch(_) {} return null; }
  function tryCaesar(s, shift) { let r = ''; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 65 && c <= 90) r += String.fromCharCode(((c-65+shift)%26+26)%26+65); else if (c >= 97 && c <= 122) r += String.fromCharCode(((c-97+shift)%26+26)%26+97); else r += s[i]; } return r; }
  function tryROT13(s) { return tryCaesar(s, 13); }
  function tryArithBytes(s, op, val) {
    try {
      let r = '';
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (op === '+') c -= val; else if (op === '-') c += val; else if (op === '^') c ^= val;
        if (c < 0 || c > 127) return null;
        r += String.fromCharCode(c);
      }
      return isPrintable(r) ? r : null;
    } catch(_) { return null; }
  }
  function tryRollingXor(bytes, seed) {
    try {
      let r = '', k = seed;
      for (let i = 0; i < bytes.length; i++) { r += String.fromCharCode(bytes[i] ^ k); k = (k + bytes[i]) & 0xFF; }
      return isPrintable(r) ? r : null;
    } catch(_) { return null; }
  }
  function detectBase64Fn(fn) {
    if (!fn?.body) return false;
    const s = JSON.stringify(fn.body);
    return (s.includes('atob') || (s.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') && s.includes('charCodeAt')));
  }
  function detectRC4Fn(fn) {
    if (!fn?.body) return false;
    const s = JSON.stringify(fn.body);
    return s.includes('256') && s.includes('charCodeAt') && s.includes('^') && (s.includes('KSA') || (s.includes('S[') && s.includes('i++') && s.includes('j')));
  }
  function simpleRC4(key, ciphertext) {
    try {
      const S = Array.from({length:256},(_,i)=>i);
      let j = 0;
      for (let i = 0; i < 256; i++) { j=(j+S[i]+key.charCodeAt(i%key.length))%256; [S[i],S[j]]=[S[j],S[i]]; }
      let i2=0, j2=0, r='';
      for (let k=0; k<ciphertext.length; k++) {
        i2=(i2+1)%256; j2=(j2+S[i2])%256; [S[i2],S[j2]]=[S[j2],S[i2]];
        r+=String.fromCharCode(ciphertext.charCodeAt(k)^S[(S[i2]+S[j2])%256]);
      }
      return isPrintable(r)?r:null;
    } catch(_){return null;}
  }

  const advancedStringDecoderPass = {
    id: 'advancedStringDecoder', name: 'Advanced String Decoder (Base64/ROT/Caesar/RC4/Rolling-XOR)', priority: 8, enabled: true,
    run(ast, { log }) {
      let decoded = 0;
      // Base64 inline: atob("...")
      traverse(ast, {
        CallExpression(path2) {
          const { callee, arguments: args } = path2.node;
          if (!t.isIdentifier(callee, { name: 'atob' }) && !(t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: 'atob' }))) return;
          if (args.length !== 1 || !t.isStringLiteral(args[0])) return;
          const r = tryBase64(args[0].value);
          if (r !== null) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
        },
      });
      // Detect and inline base64 wrapper functions
      const b64Fns = new Map();
      traverse(ast, {
        FunctionDeclaration(path2) { if (detectBase64Fn(path2.node)) b64Fns.set(path2.node.id?.name, true); },
        VariableDeclarator(path2) {
          const init = path2.node.init;
          if ((t.isFunctionExpression(init)||t.isArrowFunctionExpression(init)) && detectBase64Fn(init) && t.isIdentifier(path2.node.id)) b64Fns.set(path2.node.id.name, true);
        },
      });
      if (b64Fns.size > 0) {
        traverse(ast, {
          CallExpression(path2) {
            if (!t.isIdentifier(path2.node.callee) || !b64Fns.has(path2.node.callee.name)) return;
            const args = path2.node.arguments;
            if (args.length !== 1 || !t.isStringLiteral(args[0])) return;
            const r = tryBase64(args[0].value);
            if (r !== null) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
          },
        });
      }
      // ROT13 wrapper detection: function that calls .replace with /[A-Za-z]/g and charCode arithmetic
      const rotFns = new Map();
      traverse(ast, {
        FunctionDeclaration(path2) {
          const s = JSON.stringify(path2.node.body);
          if (s.includes('charCodeAt') && (s.includes('13') || s.includes('ROT'))) rotFns.set(path2.node.id?.name, 13);
        },
        VariableDeclarator(path2) {
          const init = path2.node.init;
          if (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init)) return;
          const s = JSON.stringify(init.body);
          if (s.includes('charCodeAt') && (s.includes('13') || s.includes('ROT')) && t.isIdentifier(path2.node.id)) rotFns.set(path2.node.id.name, 13);
        },
      });
      if (rotFns.size > 0) {
        traverse(ast, {
          CallExpression(path2) {
            if (!t.isIdentifier(path2.node.callee) || !rotFns.has(path2.node.callee.name)) return;
            const args = path2.node.arguments;
            if (args.length !== 1 || !t.isStringLiteral(args[0])) return;
            const r = tryROT13(args[0].value);
            if (isPrintable(r)) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
          },
        });
      }
      // RC4 wrapper detection
      const rc4Fns = new Map();
      traverse(ast, {
        FunctionDeclaration(path2) { if (detectRC4Fn(path2.node) && path2.node.params.length >= 2) rc4Fns.set(path2.node.id?.name, true); },
        VariableDeclarator(path2) {
          const init = path2.node.init;
          if (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init)) return;
          if (detectRC4Fn(init) && init.params.length >= 2 && t.isIdentifier(path2.node.id)) rc4Fns.set(path2.node.id.name, true);
        },
      });
      if (rc4Fns.size > 0) {
        traverse(ast, {
          CallExpression(path2) {
            if (!t.isIdentifier(path2.node.callee) || !rc4Fns.has(path2.node.callee.name)) return;
            const args = path2.node.arguments;
            if (args.length < 2 || !t.isStringLiteral(args[0]) || !t.isStringLiteral(args[1])) return;
            const r = simpleRC4(args[0].value, args[1].value) ?? simpleRC4(args[1].value, args[0].value);
            if (r !== null) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
          },
        });
      }
      // Arithmetic byte transforms: encoded strings passed through a known shift/XOR
      traverse(ast, {
        CallExpression(path2) {
          const { callee, arguments: args } = path2.node;
          // Pattern: arr.map(c => String.fromCharCode(c - N)).join('')
          if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: 'join' })) return;
          if (!args[0] || !t.isStringLiteral(args[0], { value: '' })) return;
          const mapCall = callee.object;
          if (!t.isCallExpression(mapCall) || !t.isMemberExpression(mapCall.callee) || !t.isIdentifier(mapCall.callee.property, { name: 'map' })) return;
          const arr = mapCall.callee.object;
          if (!t.isArrayExpression(arr)) return;
          const bytes = arr.elements.map(e => t.isNumericLiteral(e) ? e.value : null);
          if (bytes.some(b => b === null) || bytes.length === 0) return;
          const mapFn = mapCall.arguments[0];
          if (!mapFn || !mapFn.params || mapFn.params.length < 1) return;
          const pn = mapFn.params[0]?.name;
          if (!pn) return;
          let body = mapFn.body;
          let expr = t.isBlockStatement(body) ? extractReturnCall(body) : body;
          if (!expr || !t.isCallExpression(expr) || !isFromCharCode(expr.callee) || expr.arguments.length !== 1) return;
          const bArg = expr.arguments[0];
          if (t.isBinaryExpression(bArg) && (bArg.operator === '+' || bArg.operator === '-')) {
            const isLeftParam = t.isIdentifier(bArg.left) && bArg.left.name === pn;
            const isRightLit = t.isNumericLiteral(bArg.right);
            if (isLeftParam && isRightLit) {
              const op = bArg.operator;
              const val = bArg.right.value;
              const r = tryArithBytes(String.fromCharCode(...bytes), op === '+' ? '-' : '+', val);
              if (r !== null) { path2.replaceWith(t.stringLiteral(r)); decoded++; }
            }
          }
        },
      });
      if (decoded > 0) log('Advanced string decoder resolved ' + decoded + ' string(s)');
      else log('No advanced encoded strings found');
    },
  };

  // ── Constant Propagation ────────────────────────────────────────────────────
  const constantPropagationPass = {
    id: 'constantPropagation', name: 'Constant Propagation', priority: 18, enabled: true,
    run(ast, { log }) {
      let propagated = 0;
      // Collect top-level const declarations with primitive literal initializers
      const constMap = new Map();
      traverse(ast, {
        VariableDeclaration(path2) {
          if (path2.node.kind !== 'const') return;
          for (const decl of path2.node.declarations) {
            if (!t.isIdentifier(decl.id) || !decl.init) continue;
            const init = decl.init;
            if (t.isStringLiteral(init) || t.isNumericLiteral(init) || t.isBooleanLiteral(init) || t.isNullLiteral(init)) {
              constMap.set(decl.id.name, init);
            }
          }
        },
      });
      if (constMap.size === 0) { log('No propagatable constants found'); return; }
      // Replace reads of those consts with their literal values
      traverse(ast, {
        Identifier(path2) {
          if (!constMap.has(path2.node.name)) return;
          // Skip LHS of assignment/declaration and property keys
          const parent = path2.parent;
          if (t.isVariableDeclarator(parent) && parent.id === path2.node) return;
          if (t.isAssignmentExpression(parent) && parent.left === path2.node) return;
          if (t.isMemberExpression(parent) && !parent.computed && parent.property === path2.node) return;
          if (t.isObjectProperty(parent) && parent.key === path2.node && !parent.computed) return;
          if (t.isFunctionDeclaration(parent) || t.isClassDeclaration(parent)) return;
          const lit = constMap.get(path2.node.name);
          path2.replaceWith(t.cloneNode(lit));
          propagated++;
        },
      });
      if (propagated > 0) log('Propagated ' + propagated + ' constant(s)');
      else log('No constant propagation opportunities found');
    },
  };

  // ── Function Inliner ────────────────────────────────────────────────────────
  const functionInlinerPass = {
    id: 'functionInliner', name: 'Small Wrapper Function Inliner', priority: 35, enabled: true,
    run(ast, { log }) {
      let inlined = 0;
      // Collect single-return wrapper functions: function f(a,b,...) { return <expr using only params>; }
      const wrappers = new Map();
      function collectWrapper(name, fn) {
        if (!name || !fn?.params || !fn.body) return;
        if (!t.isBlockStatement(fn.body) || fn.body.body.length !== 1) return;
        const stmt = fn.body.body[0];
        if (!t.isReturnStatement(stmt) || !stmt.argument) return;
        const paramNames = fn.params.filter(p => t.isIdentifier(p)).map(p => p.name);
        // Body must reference only params and safe literals — no outer scope refs to avoid capture bugs
        let safe = true;
        let refCount = 0;
        try {
          traverse({ type:'File', program:{ type:'Program', body:[t.expressionStatement(stmt.argument)], directives:[], sourceType:'script' } }, {
            Identifier(ip) {
              const n = ip.node.name;
              if (!paramNames.includes(n) && !GLOBALS_SET.has(n)) { safe = false; ip.stop(); }
              refCount++;
            },
          });
        } catch(_) { safe = false; }
        if (safe && paramNames.length <= 4 && refCount <= 20) wrappers.set(name, { params: paramNames, body: stmt.argument });
      }
      traverse(ast, {
        FunctionDeclaration(path2) { collectWrapper(path2.node.id?.name, path2.node); },
        VariableDeclarator(path2) {
          const init = path2.node.init;
          if ((t.isFunctionExpression(init)||t.isArrowFunctionExpression(init)) && t.isIdentifier(path2.node.id))
            collectWrapper(path2.node.id.name, init);
        },
      });
      if (wrappers.size === 0) { log('No inlinable wrapper functions found'); return; }
      // Inline call sites
      traverse(ast, {
        CallExpression(path2) {
          if (!t.isIdentifier(path2.node.callee)) return;
          const w = wrappers.get(path2.node.callee.name);
          if (!w) return;
          const args = path2.node.arguments;
          if (args.length !== w.params.length) return;
          // Substitute params into body clone
          let bodyClone = t.cloneNode(w.body, true);
          // Simple substitution via a mini-traverse on a synthetic Program
          const subst = new Map(w.params.map((p, i) => [p, args[i]]));
          try {
            traverse({ type:'File', program:{ type:'Program', body:[t.expressionStatement(bodyClone)], directives:[], sourceType:'script' } }, {
              Identifier(ip) {
                if (subst.has(ip.node.name) && !t.isMemberExpression(ip.parent)) ip.replaceWith(t.cloneNode(subst.get(ip.node.name), true));
              },
            });
          } catch(_) { return; }
          path2.replaceWith(bodyClone);
          inlined++;
        },
      });
      if (inlined > 0) log('Inlined ' + inlined + ' wrapper function call(s)');
      else log('No wrapper function calls inlined');
    },
  };

  // ── Object Alias Inliner ────────────────────────────────────────────────────
  const objectAliasPass = {
    id: 'objectAlias', name: 'Object Alias / Proxy Inliner', priority: 36, enabled: true,
    run(ast, { log }) {
      let inlined = 0;
      // Detect: const obj = { a: fn1, b: fn2, ... } where all values are identifiers or literals
      // Then replace obj.a(...) with fn1(...)
      const aliasObjects = new Map();
      traverse(ast, {
        VariableDeclarator(path2) {
          const { id, init } = path2.node;
          if (!t.isIdentifier(id) || !t.isObjectExpression(init)) return;
          const props = {};
          let ok = true;
          for (const prop of init.properties) {
            if (!t.isObjectProperty(prop) || prop.computed || prop.shorthand) { ok = false; break; }
            const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
            if (!key) { ok = false; break; }
            if (t.isIdentifier(prop.value) || t.isStringLiteral(prop.value) || t.isNumericLiteral(prop.value) || t.isBooleanLiteral(prop.value)) {
              props[key] = prop.value;
            } else { ok = false; break; }
          }
          if (ok && Object.keys(props).length > 0) aliasObjects.set(id.name, props);
        },
      });
      if (aliasObjects.size === 0) { log('No alias objects found'); return; }
      traverse(ast, {
        MemberExpression(path2) {
          if (path2.node.computed) return;
          const obj = path2.node.object;
          const prop = path2.node.property;
          if (!t.isIdentifier(obj) || !t.isIdentifier(prop)) return;
          const alias = aliasObjects.get(obj.name);
          if (!alias || !(prop.name in alias)) return;
          // Don't inline on LHS of assignment
          if (t.isAssignmentExpression(path2.parent) && path2.parent.left === path2.node) return;
          path2.replaceWith(t.cloneNode(alias[prop.name]));
          inlined++;
        },
      });
      if (inlined > 0) log('Inlined ' + inlined + ' alias object access(es)');
      else log('No alias object accesses inlined');
    },
  };

  // ── Unused Variable / Function Removal ─────────────────────────────────────
  const unusedBindingsPass = {
    id: 'unusedBindings', name: 'Unused Variable & Function Removal', priority: 50, enabled: true,
    run(ast, { log }) {
      let removed = 0;
      // We need scope data — use traverse with scope
      const toRemove = new Set();
      traverse(ast, {
        Program(path2) {
          // Rebuild scope
          path2.scope.crawl();
        },
        VariableDeclarator(path2) {
          if (!t.isIdentifier(path2.node.id)) return;
          const name = path2.node.id.name;
          const binding = path2.scope.getBinding(name);
          if (!binding) return;
          if (binding.references === 0 && !binding.reassigned && path2.node.kind !== 'param') {
            // Only remove if initializer is side-effect free
            const init = path2.node.init;
            if (!init || t.isLiteral(init) || t.isIdentifier(init) || t.isArrayExpression(init) || t.isObjectExpression(init)) {
              toRemove.add(path2.node);
            }
          }
        },
        FunctionDeclaration(path2) {
          const name = path2.node.id?.name;
          if (!name) return;
          const binding = path2.scope.getBinding(name);
          if (binding && binding.references === 0) toRemove.add(path2.node);
        },
      });
      traverse(ast, {
        VariableDeclarator(path2) {
          if (!toRemove.has(path2.node)) return;
          const decl = path2.parentPath;
          if (decl.node.declarations.length === 1) { decl.remove(); removed++; }
          else { path2.remove(); removed++; }
        },
        FunctionDeclaration(path2) {
          if (toRemove.has(path2.node)) { path2.remove(); removed++; }
        },
      });
      if (removed > 0) log('Removed ' + removed + ' unused binding(s)');
      else log('No unused bindings found');
    },
  };

  // ── Opaque Predicate Removal ────────────────────────────────────────────────
  const opaquePredicatePass = {
    id: 'opaquePredicate', name: 'Opaque Predicate Removal', priority: 44, enabled: true,
    run(ast, { log }) {
      let removed = 0;
      // Common opaque predicates in obfuscated JS:
      // typeof window !== 'undefined', typeof module !== 'undefined', true === true, 0 === 0, etc.
      function evalOpaque(node) {
        if (!t.isBinaryExpression(node)) return null;
        const { operator, left, right } = node;
        // typeof X === 'string' / !== 'undefined' style — cannot fold without runtime
        // But we CAN fold: literal op literal
        if (t.isStringLiteral(left) && t.isStringLiteral(right)) {
          const l = left.value, r = right.value;
          switch(operator) { case '===': return l===r; case '!==': return l!==r; case '==': return l==r; case '!=': return l!=r; default: return null; } // eslint-disable-line eqeqeq
        }
        if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
          const l = left.value, r = right.value;
          switch(operator) { case '===': return l===r; case '!==': return l!==r; case '>': return l>r; case '>=': return l>=r; case '<': return l<r; case '<=': return l<=r; default: return null; }
        }
        if (t.isBooleanLiteral(left) && t.isBooleanLiteral(right)) {
          switch(operator) { case '===': return left.value===right.value; case '!==': return left.value!==right.value; default: return null; }
        }
        // !0 patterns already handled, but void 0 === undefined
        if (t.isUnaryExpression(left,{operator:'void'}) && t.isIdentifier(right,{name:'undefined'})) return operator==='===' || operator==='==' ? true : null; // eslint-disable-line eqeqeq
        return null;
      }
      traverse(ast, {
        IfStatement: { exit(path2) {
          const tv = evalOpaque(path2.node.test);
          if (tv === null) return;
          if (tv === true) {
            if (t.isBlockStatement(path2.node.consequent)) path2.replaceWithMultiple(path2.node.consequent.body);
            else path2.replaceWith(path2.node.consequent);
          } else {
            if (path2.node.alternate) {
              if (t.isBlockStatement(path2.node.alternate)) path2.replaceWithMultiple(path2.node.alternate.body);
              else path2.replaceWith(path2.node.alternate);
            } else path2.remove();
          }
          removed++;
        }},
        ConditionalExpression: { exit(path2) {
          const tv = evalOpaque(path2.node.test);
          if (tv === null) return;
          path2.replaceWith(tv ? path2.node.consequent : path2.node.alternate);
          removed++;
        }},
        // !0 => true, !1 => false, !!0 => false, !!1 => true
        UnaryExpression: { exit(path2) {
          if (path2.node.operator === '!' && t.isNumericLiteral(path2.node.argument)) {
            path2.replaceWith(t.booleanLiteral(!path2.node.argument.value)); removed++;
          } else if (path2.node.operator === '!' && t.isBooleanLiteral(path2.node.argument)) {
            path2.replaceWith(t.booleanLiteral(!path2.node.argument.value)); removed++;
          } else if (path2.node.operator === 'void' && t.isNumericLiteral(path2.node.argument)) {
            path2.replaceWith(t.identifier('undefined')); removed++;
          }
        }},
      });
      if (removed > 0) log('Removed ' + removed + ' opaque predicate(s)');
      else log('No opaque predicates found');
    },
  };

  // ── Fixed-Point Optimization Engine ────────────────────────────────────────
  // Hashes the serialized AST after every full sweep and stops only when the
  // hash is identical to the previous iteration (true fixed point).  A maximum
  // iteration cap prevents pathological loops.
  //
  // ALL purely-algebraic / non-structural passes are included so that each
  // newly-simplified constant can unlock further simplifications discovered
  // in the same round (e.g. string decoding → concat folding → dead branch).
  //
  // Structural passes (control-flow, rename, …) run in the outer pipeline and
  // are NOT repeated here to avoid unbounded rename churn.

  function astHash(ast) {
    // Fast FNV-1a over the concise code string – far cheaper than JSON.stringify
    // of the full AST and still detects any node-level change.
    let code = '';
    try { code = generate(ast, { concise: true, jsescOption: { minimal: true } }).code; } catch(_) { code = String(Date.now()); }
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }

  const iterativeFixedPointPass = {
    id: 'iterativeFixedPoint',
    name: 'Iterative Fixed-Point (hash-gated convergence)',
    priority: 95,
    enabled: true,
    async run(ast, { log, signal }) {
      // Ordered list of passes to cycle.  Priorities within the cycle are
      // deliberately from lowest (earlier) to highest (later) so that each
      // algebraic simplification immediately feeds the next.
      const cyclePasses = [
        // String resolution must come first so later folds can see literals
        advancedStringDecoderPass,
        xorDecodingPass,
        stringDecoderPass,
        // Algebraic folding
        opaquePredicatePass,
        symbolicExecutionPass,
        constantPropagationPass,
        bitwiseSimplifyPass,
        numericLiteralPass,
        templateLiteralPass,
        // Structural micro-simplifications
        propertyAccessNormPass,
        objectAliasPass,
        commaSplitterPass,
        // Control-flow recovery — runs inside the cycle (not just once) because
        // folding above can turn an opaque/dynamic switch-state expression into
        // a literal, which in turn can expose a previously-hidden dispatcher
        // loop or an if/else branch whose test just became foldable; likewise,
        // recovering structured control flow here can reveal new dead branches
        // or constant expressions for the folding passes above to pick up on
        // the *next* iteration. Order matters: controlFlowPass first (handles
        // the common case cheaply), switchDispatcherPass mops up anything that
        // only became a forever-loop after this iteration's folding.
        controlFlowPass,
        switchDispatcherPass,
        // Function-level recovery
        functionInlinerPass,
        // Dead code / junk (benefits from folding + control-flow results above)
        junkStatementPass,
        deadCodePass,
        deadAssignmentPass,
        unusedBindingsPass,
        astSimplificationPass,
      ];

      const MAX_ITER = 20;
      let prevHash = '';
      let iteration = 0;
      const perPassCounts = new Map(cyclePasses.map(p => [p.id, 0]));

      while (iteration < MAX_ITER) {
        if (signal?.aborted) throw new DOMException('Pipeline aborted', 'AbortError');

        const hashBefore = astHash(ast);
        if (hashBefore === prevHash) break;   // converged
        prevHash = hashBefore;
        iteration++;

        for (const pass of cyclePasses) {
          if (signal?.aborted) throw new DOMException('Pipeline aborted', 'AbortError');
          const h0 = astHash(ast);
          try {
            const silentLog = () => {};
            const ctx = { log: silentLog, signal, traverse, types: t };
            if (pass.run.constructor.name === 'AsyncFunction') await pass.run(ast, ctx);
            else pass.run(ast, ctx);
          } catch(_) { /* individual pass errors must not abort the cycle */ }
          const h1 = astHash(ast);
          if (h0 !== h1) perPassCounts.set(pass.id, (perPassCounts.get(pass.id) ?? 0) + 1);
        }
      }

      const hashAfter = astHash(ast);
      const converged = hashAfter === prevHash;
      const activePasses = [...perPassCounts.entries()].filter(([,c]) => c > 0).map(([id,c]) => id + '×' + c).join(', ');
      log(
        'Fixed-point ' + (converged ? 'converged' : 'capped') + ' after ' + iteration + ' iteration(s)' +
        (activePasses ? ' [' + activePasses + ']' : '')
      );
    },
  };

  // ── Unicode Script Normalization (extended) ─────────────────────────────────
  const extendedUnicodeNormPass = {
    id: 'extendedUnicodeNorm', name: 'Extended Unicode Script Normalization', priority: 11, enabled: true,
    run(ast, { log }) {
      let count = 0;
      // Extended homoglyph map: Coptic, Armenian, Syriac, Thaana, Mathematical alphabets, Fullwidth
      // Combined with the base HOMOGLYPH_MAP so extNormalize never calls normalizeStr() per character.
      const EXTENDED_MAP = {
        // Fullwidth Latin
        '\uFF21':'A','\uFF22':'B','\uFF23':'C','\uFF24':'D','\uFF25':'E','\uFF26':'F','\uFF27':'G','\uFF28':'H','\uFF29':'I','\uFF2A':'J','\uFF2B':'K','\uFF2C':'L','\uFF2D':'M','\uFF2E':'N','\uFF2F':'O','\uFF30':'P','\uFF31':'Q','\uFF32':'R','\uFF33':'S','\uFF34':'T','\uFF35':'U','\uFF36':'V','\uFF37':'W','\uFF38':'X','\uFF39':'Y','\uFF3A':'Z',
        '\uFF41':'a','\uFF42':'b','\uFF43':'c','\uFF44':'d','\uFF45':'e','\uFF46':'f','\uFF47':'g','\uFF48':'h','\uFF49':'i','\uFF4A':'j','\uFF4B':'k','\uFF4C':'l','\uFF4D':'m','\uFF4E':'n','\uFF4F':'o','\uFF50':'p','\uFF51':'q','\uFF52':'r','\uFF53':'s','\uFF54':'t','\uFF55':'u','\uFF56':'v','\uFF57':'w','\uFF58':'x','\uFF59':'y','\uFF5A':'z',
        // Mathematical bold/italic/script (sample range)
        '\u{1D400}':'A','\u{1D401}':'B','\u{1D402}':'C','\u{1D403}':'D','\u{1D404}':'E',
        '\u{1D41A}':'a','\u{1D41B}':'b','\u{1D41C}':'c','\u{1D41D}':'d','\u{1D41E}':'e',
        // Modifier letters
        '\u02B0':'h','\u02B2':'j','\u02B3':'r','\u02B7':'w','\u02B8':'y',
        // Coptic (common homoglyphs)
        '\u03E2':'S','\u03E3':'s','\u03E4':'F','\u03E5':'f',
        // Armenian (selected)
        '\u0531':'A','\u0532':'B','\u0535':'E','\u053F':'K',
        // Cyrillic (augment existing map)
        '\u0456':'i','\u0406':'I','\u0439':'u','\u0446':'c',
        // Base Cyrillic + Greek from HOMOGLYPH_MAP (merged here so we never call normalizeStr per char)
        ...HOMOGLYPH_MAP,
      };
      // Fast ASCII check reused from needsNormalization — avoids regex allocation
      const NON_ASCII = /[^\x00-\x7F]/;
      // Cache normalized results per unique identifier name. In a minified file the
      // same obfuscated name can appear thousands of times; compute the result once.
      const identNormCache = new Map();
      function extNormalize(name) {
        // Fast path: already pure ASCII
        if (!NON_ASCII.test(name)) return name;
        let cached = identNormCache.get(name);
        if (cached !== undefined) return cached;
        // NFKD decompose + strip combining diacritics in one pass
        let r = name.normalize('NFKD').replace(/[\u0300-\u036F\u1DC0-\u1DFF\u20D0-\u20FF]/g, '');
        // Map each character through the combined table; unknown non-ASCII → keep as-is for now
        let out = '';
        for (const ch of r) out += EXTENDED_MAP[ch] ?? ch;
        // Strip invisible/zero-width characters
        out = out.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFFD\uFE00-\uFE0F]/g, '');
        // Replace any remaining non-ASCII that couldn't be mapped
        out = out.replace(/[^\x00-\x7F]/g, '_');
        identNormCache.set(name, out);
        return out;
      }
      traverse(ast, {
        Identifier(path2) {
          const name = path2.node.name;
          if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return; // already ASCII-safe
          const normalized = extNormalize(name);
          if (normalized === name || !normalized || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(normalized)) return;
          try {
            const binding = path2.scope?.getBinding(name);
            if (binding) { path2.scope.rename(name, normalized); count++; }
            else { path2.node.name = normalized; count++; }
          } catch(_) {}
        },
      });
      if (count > 0) log('Extended unicode normalization: renamed ' + count + ' identifier(s)');
      else log('No extended unicode identifiers found');
    },
  };

  // ── Semantic Rename (data-flow based) ──────────────────────────────────────
  const semanticRenamePass = {
    id: 'semanticRename', name: 'Semantic Variable Rename (data-flow)', priority: 91, enabled: false,
    run(ast, { log }) {
      let renamed = 0;
      // Heuristics: infer name from: assigned string, called-function name, property access, typeof
      function inferName(binding) {
        if (!binding || !binding.path) return null;
        const path2 = binding.path;
        // From initializer
        const init = path2.isVariableDeclarator() ? path2.node.init : null;
        if (init) {
          if (t.isStringLiteral(init)) return 'str_' + init.value.replace(/[^a-zA-Z0-9]/g,'_').slice(0,12);
          if (t.isNumericLiteral(init)) return 'num_' + String(init.value).replace(/[^0-9]/g,'_');
          if (t.isBooleanLiteral(init)) return init.value ? 'flagTrue' : 'flagFalse';
          if (t.isNewExpression(init) && t.isIdentifier(init.callee)) return lcFirst(init.callee.name) + 'Inst';
          if (t.isCallExpression(init) && t.isIdentifier(init.callee)) return lcFirst(init.callee.name) + 'Result';
          if (t.isCallExpression(init) && t.isMemberExpression(init.callee) && t.isIdentifier(init.callee.property)) return lcFirst(init.callee.property.name) + 'Result';
          if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) return 'fn_' + (path2.node.id?.name ?? 'anon');
          if (t.isArrayExpression(init)) return 'arr';
          if (t.isObjectExpression(init)) return 'obj';
        }
        // From references: if used as a callee, it's a fn
        if (binding.referencePaths.some(r => t.isCallExpression(r.parent) && r.parent.callee === r.node)) return 'fn';
        // From typeof check
        if (binding.referencePaths.some(r => t.isUnaryExpression(r.parent) && r.parent.operator === 'typeof')) return 'val';
        return null;
      }
      function lcFirst(s) { return s && s.length ? s[0].toLowerCase() + s.slice(1) : s; }
      const renamedNames = new Set();
      traverse(ast, {
        Program(path2) { path2.scope.crawl(); },
        'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|Program'(path2) {
          const bindings = path2.scope?.bindings ?? {};
          for (const [name, binding] of Object.entries(bindings)) {
            if (!isGarbled(name)) continue;
            const inferred = inferName(binding);
            if (!inferred) continue;
            // Make unique
            let newName = inferred;
            let idx = 0;
            while (renamedNames.has(newName) || bindings[newName]) newName = inferred + '_' + (++idx);
            renamedNames.add(newName);
            try { path2.scope.rename(name, newName); renamed++; } catch(_) {}
          }
        },
      });
      if (renamed > 0) log('Semantic rename: renamed ' + renamed + ' identifier(s)');
      else log('No garbled identifiers found for semantic rename');
    },
  };

  // ── Switch Dispatcher Flatten (enhanced) ───────────────────────────────────
  const switchDispatcherPass = {
    id: 'switchDispatcher', name: 'Switch Dispatcher Flatten (CFG-backed)', priority: 23, enabled: true,
    run(ast, { log }) {
      // controlFlowPass already handles while/for/do-while forever-loops.
      // This pass mops up any remaining forever loops that slipped through on a
      // first pass (e.g. loops that only became "forever" after constant folding)
      // and also handles array-index dispatcher patterns nested inside an outer
      // while(true) that weren't caught because the inner switch uses arr[counter++].
      let recovered = 0;

      traverse(ast, {
        WhileStatement(path2) {
          if (!isForeverLoop(path2.node)) return;
          // Already handled by controlFlowPass, but try again for residual cases
          const result = tryFullCFGRecovery(path2);
          if (result && result.length > 0) {
            try { path2.replaceWithMultiple(result); recovered++; } catch(_) {}
          }
        },
        ForStatement(path2) {
          if (!isForeverLoop(path2.node)) return;
          const result = tryFullCFGRecovery(path2);
          if (result && result.length > 0) {
            try { path2.replaceWithMultiple(result); recovered++; } catch(_) {}
          }
        },
        DoWhileStatement(path2) {
          if (!isForeverLoop(path2.node)) return;
          const result = tryFullCFGRecovery(path2);
          if (result && result.length > 0) {
            try { path2.replaceWithMultiple(result); recovered++; } catch(_) {}
          }
        },
      });

      if (recovered > 0) log('Switch dispatcher: recovered ' + recovered + ' additional block(s)');
      else log('No residual dispatcher patterns found');
    },
  };

  // ── Liveness / dead-assignment removal ─────────────────────────────────────
  const deadAssignmentPass = {
    id: 'deadAssignment', name: 'Dead Assignment Removal', priority: 49, enabled: true,
    run(ast, { log }) {
      let removed = 0;
      traverse(ast, {
        AssignmentExpression(path2) {
          // var x = ...; x = ...; x = ...; — remove intermediate assignments never read
          if (!t.isIdentifier(path2.node.left)) return;
          const name = path2.node.left.name;
          if (!path2.parentPath.isExpressionStatement()) return;
          const binding = path2.scope.getBinding(name);
          if (!binding || binding.references > 0 || binding.reassigned) return;
          // If there are no reads and it's a simple assignment
          const right = path2.node.right;
          // Only remove if RHS is side-effect free
          if (t.isLiteral(right) || t.isIdentifier(right)) {
            path2.parentPath.remove(); removed++;
          }
        },
      });
      if (removed > 0) log('Removed ' + removed + ' dead assignment(s)');
      else log('No dead assignments found');
    },
  };

  // ── Junk Statement Removal ─────────────────────────────────────────────────
  const junkStatementPass = {
    id: 'junkStatement', name: 'Junk Statement Removal', priority: 48, enabled: true,
    run(ast, { log }) {
      let removed = 0;
      traverse(ast, {
        ExpressionStatement(path2) {
          const expr = path2.node.expression;
          // Standalone literals that do nothing
          if (t.isStringLiteral(expr) && !path2.parentPath.isProgram() && !path2.parentPath.isBlockStatement()) return;
          if (t.isStringLiteral(expr)) {
            const val = expr.value;
            if (val !== 'use strict' && val !== 'use client' && val !== 'use server') { path2.remove(); removed++; return; }
          }
          // void 0, void false etc
          if (t.isUnaryExpression(expr) && expr.operator === 'void' && t.isLiteral(expr.argument)) { path2.remove(); removed++; return; }
          // Junk arithmetic: 1+1, "x"+"y" with no assignment
          if (t.isBinaryExpression(expr) && ['+','-','*','/','|','&','^'].includes(expr.operator)) {
            const lp = t.isLiteral(expr.left), rp = t.isLiteral(expr.right);
            if (lp && rp) { path2.remove(); removed++; return; }
          }
        },
      });
      if (removed > 0) log('Removed ' + removed + ' junk statement(s)');
      else log('No junk statements found');
    },
  };

  // ══════════════════════════════════════════════════════════════════════════════
  // SYMBOLIC EXECUTION ENGINE
  //
  // Statically evaluates deterministic sub-expressions without running any user
  // code.  Uses a recursive interpreter over the Babel AST with an environment
  // (scope → value map) seeded from already-known constants.
  //
  // SAFE to evaluate:  arithmetic, bitwise, string ops, array literals, object
  //   literals, constant-bound loops (≤ LOOP_LIMIT iterations), recursion with
  //   constant args (≤ RECUR_LIMIT depth), array/object property reads.
  //
  // NEVER evaluated:  anything touching DOM, window, document, fetch, XHR,
  //   WebSocket, navigator, timers, eval, new Function, or any identifier that
  //   isn't fully resolved in the local environment.
  // ══════════════════════════════════════════════════════════════════════════════

  const SYM_LOOP_LIMIT  = 256;   // max iterations of a constant-bound loop
  const SYM_RECUR_LIMIT = 64;    // max recursive call depth
  const SYM_EXPR_LIMIT  = 4096;  // max AST nodes visited per top-level eval
  const SYM_SENTINEL    = Symbol('SYM_UNRESOLVED');

  // Blocklisted global identifiers – must NOT be evaluated
  const SYM_BLOCKED = new Set([
    'window','document','navigator','location','history','screen',
    'fetch','XMLHttpRequest','WebSocket','EventSource',
    'setTimeout','setInterval','clearTimeout','clearInterval',
    'requestAnimationFrame','cancelAnimationFrame',
    'alert','confirm','prompt','open','close',
    'localStorage','sessionStorage','indexedDB','caches',
    'eval','Function','importScripts','postMessage','self',
    'crypto','performance','process','require','module','exports',
    '__dirname','__filename','global','globalThis',
  ]);

  function symUnresolved(v) { return v === SYM_SENTINEL; }

  class SymEnv {
    constructor(parent = null) { this._m = new Map(); this._parent = parent; }
    get(k) {
      if (this._m.has(k)) return this._m.get(k);
      return this._parent ? this._parent.get(k) : SYM_SENTINEL;
    }
    set(k, v) { this._m.set(k, v); }
    child() { return new SymEnv(this); }
  }

  // Evaluate a Babel AST node deterministically.
  // Returns SYM_SENTINEL when the value cannot be proven.
  function symEval(node, env, depth = 0, visited = { n: 0 }) {
    if (!node) return SYM_SENTINEL;
    if (++visited.n > SYM_EXPR_LIMIT) return SYM_SENTINEL;
    if (depth > SYM_RECUR_LIMIT) return SYM_SENTINEL;

    switch (node.type) {
      case 'NumericLiteral':  return node.value;
      case 'StringLiteral':   return node.value;
      case 'BooleanLiteral':  return node.value;
      case 'NullLiteral':     return null;
      case 'Identifier': {
        if (node.name === 'undefined') return undefined;
        if (node.name === 'Infinity')  return Infinity;
        if (node.name === 'NaN')       return NaN;
        if (SYM_BLOCKED.has(node.name)) return SYM_SENTINEL;
        const v = env.get(node.name);
        return v;
      }
      case 'UnaryExpression': {
        const arg = symEval(node.argument, env, depth, visited);
        if (symUnresolved(arg)) return SYM_SENTINEL;
        switch (node.operator) {
          case '-':      return -arg;
          case '+':      return +arg;
          case '~':      return ~arg;
          case '!':      return !arg;
          case 'typeof': return typeof arg;
          case 'void':   return undefined;
          default:       return SYM_SENTINEL;
        }
      }
      case 'BinaryExpression': {
        const l = symEval(node.left,  env, depth, visited);
        const r = symEval(node.right, env, depth, visited);
        if (symUnresolved(l) || symUnresolved(r)) return SYM_SENTINEL;
        switch (node.operator) {
          case '+':   return l + r;
          case '-':   return l - r;
          case '*':   return l * r;
          case '/':   return r === 0 ? SYM_SENTINEL : l / r;
          case '%':   return r === 0 ? SYM_SENTINEL : l % r;
          case '**':  return l ** r;
          case '&':   return l & r;
          case '|':   return l | r;
          case '^':   return l ^ r;
          case '<<':  return l << r;
          case '>>':  return l >> r;
          case '>>>': return l >>> r;
          case '===': return l === r;
          case '!==': return l !== r;
          case '==':  return l == r;  // eslint-disable-line eqeqeq
          case '!=':  return l != r;  // eslint-disable-line eqeqeq
          case '<':   return l < r;
          case '<=':  return l <= r;
          case '>':   return l > r;
          case '>=':  return l >= r;
          case 'in':
          case 'instanceof': return SYM_SENTINEL;
          default:    return SYM_SENTINEL;
        }
      }
      case 'LogicalExpression': {
        const l2 = symEval(node.left, env, depth, visited);
        if (symUnresolved(l2)) return SYM_SENTINEL;
        if (node.operator === '&&') return l2 ? symEval(node.right, env, depth, visited) : l2;
        if (node.operator === '||') return l2 ? l2 : symEval(node.right, env, depth, visited);
        if (node.operator === '??') return (l2 === null || l2 === undefined) ? symEval(node.right, env, depth, visited) : l2;
        return SYM_SENTINEL;
      }
      case 'ConditionalExpression': {
        const test = symEval(node.test, env, depth, visited);
        if (symUnresolved(test)) return SYM_SENTINEL;
        return test ? symEval(node.consequent, env, depth, visited) : symEval(node.alternate, env, depth, visited);
      }
      case 'TemplateLiteral': {
        let r = '';
        for (let i = 0; i < node.quasis.length; i++) {
          r += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
          if (i < node.expressions.length) {
            const ev = symEval(node.expressions[i], env, depth, visited);
            if (symUnresolved(ev)) return SYM_SENTINEL;
            r += String(ev);
          }
        }
        return r;
      }
      case 'ArrayExpression': {
        const arr = [];
        for (const el of node.elements) {
          if (!el) { arr.push(undefined); continue; }
          if (el.type === 'SpreadElement') return SYM_SENTINEL;
          const v = symEval(el, env, depth, visited);
          if (symUnresolved(v)) return SYM_SENTINEL;
          arr.push(v);
        }
        return arr;
      }
      case 'ObjectExpression': {
        const obj = {};
        for (const prop of node.properties) {
          if (prop.type !== 'ObjectProperty' || prop.computed) return SYM_SENTINEL;
          const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
          if (key === null) return SYM_SENTINEL;
          const val = symEval(prop.value, env, depth, visited);
          if (symUnresolved(val)) return SYM_SENTINEL;
          obj[key] = val;
        }
        return obj;
      }
      case 'MemberExpression': {
        if (node.computed) {
          const obj = symEval(node.object, env, depth, visited);
          const prop = symEval(node.property, env, depth, visited);
          if (symUnresolved(obj) || symUnresolved(prop)) return SYM_SENTINEL;
          if (obj === null || obj === undefined) return SYM_SENTINEL;
          if (SYM_BLOCKED.has(String(prop))) return SYM_SENTINEL;
          try { const v = obj[prop]; return (typeof v === 'function') ? SYM_SENTINEL : v; } catch(_) { return SYM_SENTINEL; }
        } else {
          const propName = node.property.name ?? node.property.value;
          if (SYM_BLOCKED.has(propName)) return SYM_SENTINEL;
          const obj = symEval(node.object, env, depth, visited);
          if (symUnresolved(obj) || obj === null || obj === undefined) return SYM_SENTINEL;
          // Allow safe string/array built-ins by value only (no function calls)
          try {
            const v = obj[propName];
            return (typeof v === 'function') ? SYM_SENTINEL : v;
          } catch(_) { return SYM_SENTINEL; }
        }
      }
      case 'CallExpression': {
        // Only evaluate a curated allowlist of pure built-ins
        const { callee, arguments: args } = node;
        const evalledArgs = args.map(a => symEval(a, env, depth, visited));
        if (evalledArgs.some(symUnresolved)) return SYM_SENTINEL;

        // String.fromCharCode(...)
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: 'String' }) && t.isIdentifier(callee.property, { name: 'fromCharCode' }))
          try { return String.fromCharCode(...evalledArgs); } catch(_) { return SYM_SENTINEL; }

        // String.prototype methods: .charAt .charCodeAt .indexOf .slice .substring .split .replace .toUpperCase .toLowerCase .trim .repeat .padStart .padEnd .startsWith .endsWith .includes
        const SAFE_STR_METHODS = new Set(['charAt','charCodeAt','indexOf','lastIndexOf','slice','substring','substr','split','toUpperCase','toLowerCase','trim','trimStart','trimEnd','repeat','padStart','padEnd','startsWith','endsWith','includes','concat','at']);
        // Array.prototype methods: .join .slice .indexOf .includes .concat .reverse .flat .map .filter (only when fn is pure)
        const SAFE_ARR_METHODS = new Set(['join','slice','indexOf','lastIndexOf','includes','concat','flat','reverse','at','length']);

        if (t.isMemberExpression(callee)) {
          const obj = symEval(callee.object, env, depth, visited);
          if (symUnresolved(obj)) return SYM_SENTINEL;
          const method = callee.computed
            ? symEval(callee.property, env, depth, visited)
            : (callee.property.name ?? callee.property.value);
          if (symUnresolved(method) || SYM_BLOCKED.has(method)) return SYM_SENTINEL;
          if (typeof obj === 'string' && SAFE_STR_METHODS.has(method)) {
            try { return obj[method](...evalledArgs); } catch(_) { return SYM_SENTINEL; }
          }
          if (Array.isArray(obj) && SAFE_ARR_METHODS.has(method)) {
            try {
              const v = obj[method](...evalledArgs);
              return (typeof v === 'function') ? SYM_SENTINEL : v;
            } catch(_) { return SYM_SENTINEL; }
          }
          // Math.*
          const SAFE_MATH = new Set(['abs','ceil','floor','round','min','max','pow','sqrt','log','log2','log10','sign','trunc','clz32','imul','fround']);
          if (t.isIdentifier(callee.object, { name: 'Math' }) && SAFE_MATH.has(method)) {
            try { return Math[method](...evalledArgs); } catch(_) { return SYM_SENTINEL; }
          }
          // Number.parseInt, Number.parseFloat, Number.isNaN, Number.isFinite
          if (t.isIdentifier(callee.object, { name: 'Number' })) {
            if (method === 'parseInt')  try { return parseInt(evalledArgs[0], evalledArgs[1]); } catch(_) { return SYM_SENTINEL; }
            if (method === 'parseFloat') try { return parseFloat(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
            if (method === 'isNaN')      return Number.isNaN(evalledArgs[0]);
            if (method === 'isFinite')   return Number.isFinite(evalledArgs[0]);
          }
          // JSON.stringify / JSON.parse on literal values
          if (t.isIdentifier(callee.object, { name: 'JSON' })) {
            if (method === 'stringify') try { return JSON.stringify(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
            if (method === 'parse')     try { return JSON.parse(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
          }
        }

        // parseInt / parseFloat top-level
        if (t.isIdentifier(callee, { name: 'parseInt' }))   try { return parseInt(evalledArgs[0], evalledArgs[1]); } catch(_) { return SYM_SENTINEL; }
        if (t.isIdentifier(callee, { name: 'parseFloat' })) try { return parseFloat(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
        if (t.isIdentifier(callee, { name: 'isNaN' }))      return isNaN(evalledArgs[0]);
        if (t.isIdentifier(callee, { name: 'isFinite' }))   return isFinite(evalledArgs[0]);
        if (t.isIdentifier(callee, { name: 'String' }))     try { return String(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
        if (t.isIdentifier(callee, { name: 'Number' }))     try { return Number(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
        if (t.isIdentifier(callee, { name: 'Boolean' }))    return Boolean(evalledArgs[0]);
        if (t.isIdentifier(callee, { name: 'encodeURIComponent' })) try { return encodeURIComponent(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
        if (t.isIdentifier(callee, { name: 'decodeURIComponent' })) try { return decodeURIComponent(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
        if (t.isIdentifier(callee, { name: 'atob' })) try { return atob(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }
        if (t.isIdentifier(callee, { name: 'btoa' })) try { return btoa(evalledArgs[0]); } catch(_) { return SYM_SENTINEL; }

        // User-defined function call — evaluate if body is known & simple
        if (t.isIdentifier(callee)) {
          const fnVal = env.get(callee.name);
          if (symUnresolved(fnVal) || typeof fnVal !== 'object' || !fnVal?.__symFn) return SYM_SENTINEL;
          return symCallFn(fnVal, evalledArgs, env, depth + 1, visited);
        }
        return SYM_SENTINEL;
      }
      case 'SequenceExpression': {
        let last = SYM_SENTINEL;
        for (const expr of node.expressions) { last = symEval(expr, env, depth, visited); }
        return last;
      }
      case 'AssignmentExpression': {
        if (node.operator !== '=') return SYM_SENTINEL;
        if (!t.isIdentifier(node.left)) return SYM_SENTINEL;
        const val = symEval(node.right, env, depth, visited);
        if (!symUnresolved(val)) env.set(node.left.name, val);
        return val;
      }
      // Function expressions/declarations evaluate to a closure record that
      // captures the *defining* environment (not the call-site environment).
      // This is what makes recursive calls with constant inputs resolvable:
      // the closure's own name is bound inside its captured scope so a
      // self-call inside the body can look itself up via `env.get(name)`.
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        if (node.generator || node.async) return SYM_SENTINEL;
        // Arrow functions with expression bodies are normalized to a single
        // implicit-return block at call time inside symCallFn.
        const closure = {
          __symFn: true,
          params: node.params,
          body: node.body,
          isExpr: node.type === 'ArrowFunctionExpression' && !t.isBlockStatement(node.body),
          closureEnv: env,
          name: t.isFunctionExpression(node) && node.id ? node.id.name : null,
        };
        // Named function expressions can recurse via their own local name.
        if (closure.name) {
          const selfEnv = env.child();
          selfEnv.set(closure.name, closure);
          closure.closureEnv = selfEnv;
        }
        return closure;
      }
      default:
        return SYM_SENTINEL;
    }
  }

  // Execute a known user-defined function symbolically.
  // Crucially, the closure is invoked against an environment chained off of
  // its *captured* (definition-site) scope — callerEnv is only used to
  // resolve the already-evaluated argument values, never as the parent scope
  // of the callee's locals. This keeps recursive calls correct: each
  // invocation sees the function's own name + its defining scope, not
  // whatever happened to be in scope at an arbitrary call site.
  function symCallFn(fnDef, args, callerEnv, depth, visited) {
    const { params, body, isExpr } = fnDef;
    if (!body || depth > SYM_RECUR_LIMIT) return SYM_SENTINEL;
    const localEnv = (fnDef.closureEnv ?? callerEnv).child();
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (t.isIdentifier(p)) {
        localEnv.set(p.name, args[i] ?? undefined);
      } else if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) {
        // Default parameter: use provided arg unless it's undefined.
        const provided = args[i];
        if (provided === undefined) {
          const dflt = symEval(p.right, localEnv, depth, visited);
          localEnv.set(p.left.name, symUnresolved(dflt) ? undefined : dflt);
        } else {
          localEnv.set(p.left.name, provided);
        }
      } else {
        // Destructuring / rest params are not supported symbolically.
        return SYM_SENTINEL;
      }
    }
    if (isExpr) {
      // Arrow function with an implicit-return expression body.
      return symEval(body, localEnv, depth, visited);
    }
    // symExecBlock already unwraps the internal {__symReturn,value} marker
    // and returns the raw value directly (or `undefined` if the function
    // body never hit a return statement) — do not unwrap it a second time.
    return symExecBlock(body, localEnv, depth, visited);
  }

  // Execute a block of statements, return value of first ReturnStatement
  function symExecBlock(block, env, depth, visited) {
    if (!t.isBlockStatement(block) || depth > SYM_RECUR_LIMIT) return SYM_SENTINEL;
    // Hoist function declarations first (real JS semantics: a FunctionDeclaration
    // is visible to every statement in its enclosing block, including ones that
    // textually precede it — this is what allows mutual recursion between two
    // sibling helper functions to resolve).
    for (const stmt of block.body) {
      if (stmt.type !== 'FunctionDeclaration' || !stmt.id) continue;
      const closure = {
        __symFn: true,
        params: stmt.params,
        body: stmt.body,
        isExpr: false,
        closureEnv: env,
        name: stmt.id.name,
      };
      env.set(stmt.id.name, closure);
    }
    for (const stmt of block.body) {
      if (stmt.type === 'FunctionDeclaration') continue; // already hoisted above
      const r = symExecStmt(stmt, env, depth, visited);
      if (r !== SYM_SENTINEL && r !== null && typeof r === 'object' && r.__symReturn) return r.value;
      // Side-effecting stmts (var decl, expr stmt) mutate env; we continue
    }
    return undefined;
  }

  function symExecStmt(stmt, env, depth, visited) {
    if (!stmt) return SYM_SENTINEL;
    if (++visited.n > SYM_EXPR_LIMIT) return SYM_SENTINEL;
    switch (stmt.type) {
      case 'ReturnStatement': {
        const val = stmt.argument ? symEval(stmt.argument, env, depth, visited) : undefined;
        return { __symReturn: true, value: val };
      }
      case 'VariableDeclaration': {
        for (const decl of stmt.declarations) {
          if (!t.isIdentifier(decl.id) || !decl.init) continue;
          const val = symEval(decl.init, env, depth, visited);
          if (!symUnresolved(val)) env.set(decl.id.name, val);
        }
        return null;
      }
      case 'ExpressionStatement': {
        symEval(stmt.expression, env, depth, visited);
        return null;
      }
      case 'IfStatement': {
        const test = symEval(stmt.test, env, depth, visited);
        if (symUnresolved(test)) return SYM_SENTINEL;
        const branch = test ? stmt.consequent : stmt.alternate;
        if (!branch) return null;
        if (t.isBlockStatement(branch)) return symExecBlock(branch, env, depth, visited);
        return symExecStmt(branch, env, depth, visited);
      }
      case 'BlockStatement':
        return symExecBlock(stmt, env, depth, visited);
      case 'ForStatement': {
        // Only evaluate with constant bounds
        if (stmt.init) symExecStmt(stmt.init, env, depth, visited);
        let iters = 0;
        while (iters++ < SYM_LOOP_LIMIT) {
          if (stmt.test) { const tv = symEval(stmt.test, env, depth, visited); if (symUnresolved(tv) || !tv) break; }
          const r = symExecBlock(t.isBlockStatement(stmt.body) ? stmt.body : t.blockStatement([stmt.body]), env, depth, visited);
          if (r && typeof r === 'object' && r.__symReturn) return r;
          if (stmt.update) symEval(stmt.update, env, depth, visited);
        }
        return null;
      }
      case 'WhileStatement': {
        let iters = 0;
        while (iters++ < SYM_LOOP_LIMIT) {
          const tv = symEval(stmt.test, env, depth, visited);
          if (symUnresolved(tv) || !tv) break;
          const r = symExecBlock(t.isBlockStatement(stmt.body) ? stmt.body : t.blockStatement([stmt.body]), env, depth, visited);
          if (r && typeof r === 'object' && r.__symReturn) return r;
        }
        return null;
      }
      default:
        return SYM_SENTINEL;
    }
  }

  // Build a SymEnv pre-seeded with all const literals and named function
  // declarations visible in the program. Function declarations are required
  // here (not just inside symExecBlock's per-block hoisting) because the
  // *call site* doing the folding is often a sibling statement at module
  // scope, sharing this same top-level env, rather than a nested block.
  function buildTopLevelEnv(ast) {
    const env = new SymEnv();
    traverse(ast, {
      VariableDeclarator(path2) {
        if (path2.parent.kind !== 'const' || !t.isIdentifier(path2.node.id) || !path2.node.init) return;
        const v = symEval(path2.node.init, env);
        if (!symUnresolved(v)) env.set(path2.node.id.name, v);
      },
      FunctionDeclaration(path2) {
        if (!path2.node.id || path2.node.generator || path2.node.async) return;
        // Only hoist declarations whose enclosing scope is the Program itself
        // (top-level function statements) — deeply nested closures over
        // mutable outer variables aren't safe to treat as globally pure here
        // and are instead handled locally by symExecBlock's per-block hoisting
        // at call time. This also avoids name collisions between two
        // same-named helper functions declared in unrelated nested scopes.
        if (!path2.parentPath.isProgram()) return;
        env.set(path2.node.id.name, {
          __symFn: true,
          params: path2.node.params,
          body: path2.node.body,
          isExpr: false,
          closureEnv: env,
          name: path2.node.id.name,
        });
      },
    });
    // Second pass: pick up consts whose initialisers reference earlier consts
    // or reference one of the function declarations just registered above.
    traverse(ast, {
      VariableDeclarator(path2) {
        if (path2.parent.kind !== 'const' || !t.isIdentifier(path2.node.id) || !path2.node.init) return;
        if (!symUnresolved(env.get(path2.node.id.name))) return;
        const v = symEval(path2.node.init, env);
        if (!symUnresolved(v)) env.set(path2.node.id.name, v);
      },
    });
    return env;
  }

  // Convert a JS primitive to a Babel literal node (returns null if not convertible)
  function primitiveToLiteral(v) {
    if (typeof v === 'string')  return t.stringLiteral(v);
    if (typeof v === 'number')  {
      if (!isFinite(v)) return null;
      if (v < 0) return t.unaryExpression('-', t.numericLiteral(-v));
      return t.numericLiteral(v);
    }
    if (typeof v === 'boolean') return t.booleanLiteral(v);
    if (v === null)             return t.nullLiteral();
    if (v === undefined)        return t.identifier('undefined');
    return null;
  }

  const symbolicExecutionPass = {
    id: 'symbolicExecution',
    name: 'Symbolic Execution (safe deterministic evaluation)',
    priority: 20,
    enabled: true,
    run(ast, { log }) {
      let folded = 0;
      const topEnv = buildTopLevelEnv(ast);

      traverse(ast, {
        // Only replace expression nodes that are NOT already literals
        'BinaryExpression|UnaryExpression|CallExpression|ConditionalExpression|LogicalExpression|TemplateLiteral|MemberExpression': {
          exit(path2) {
            // Skip if already a literal or inside a declaration LHS
            if (t.isLiteral(path2.node)) return;
            if (path2.isLHS?.()) return;
            // Skip if it's the callee of a call (avoid self-referential replacement)
            if (t.isCallExpression(path2.parent) && path2.parent.callee === path2.node) return;
            // Skip MemberExpression that's the callee of a call
            if (t.isMemberExpression(path2.node) && t.isCallExpression(path2.parent) && path2.parent.callee === path2.node) return;

            // Build a local env from the current scope's bindings (only literals
            // and named function declarations — both are safe to treat as
            // constant for the lifetime of a single fold attempt).
            const localEnv = topEnv.child();
            try {
              const bindings = path2.scope?.bindings ?? {};
              for (const [name, binding] of Object.entries(bindings)) {
                if (SYM_BLOCKED.has(name)) continue;
                const bp = binding.path;
                if (!bp) continue;
                if (bp.isFunctionDeclaration()) {
                  const fn = bp.node;
                  if (!fn.generator && !fn.async) {
                    const closure = { __symFn: true, params: fn.params, body: fn.body, isExpr: false, closureEnv: localEnv, name: fn.id?.name ?? name };
                    localEnv.set(name, closure);
                  }
                  continue;
                }
                const init = bp.isVariableDeclarator() ? bp.node.init : null;
                if (!init) continue;
                const v2 = symEval(init, localEnv, 0, { n: 0 });
                if (!symUnresolved(v2)) localEnv.set(name, v2);
              }
            } catch(_) {}

            const val = symEval(path2.node, localEnv, 0, { n: 0 });
            if (symUnresolved(val)) return;
            // Reject if the value would change semantics (NaN, Infinity, objects, functions)
            if (typeof val === 'object' && val !== null) return;
            if (typeof val === 'function') return;
            if (typeof val === 'number' && !isFinite(val)) return;
            const lit = primitiveToLiteral(val);
            if (!lit) return;
            // Don't replace a node with an identical literal (avoids infinite loops)
            if (t.isLiteral(path2.node) && path2.node.value === val) return;
            try { path2.replaceWith(lit); folded++; } catch(_) {}
          },
        },
      });

      if (folded > 0) log('Symbolic execution folded ' + folded + ' expression(s)');
      else log('No symbolically foldable expressions found');
    },
  };

  // ── Register all passes ────────────────────────────────────────────────────
  const reg = new TransformRegistry();
  reg.registerAll([
    runtimePatternPass, zeroxDecoderPass, stringArrayCleanupPass,
    stringDecoderPass, advancedStringDecoderPass, xorDecodingPass,
    homoglyphCleanupPass, extendedUnicodeNormPass, unicodeNormalizationPass,
    hexDeobfuscationPass, templateLiteralPass, constantPropagationPass,
    bitwiseSimplifyPass, numericLiteralPass, propertyAccessNormPass,
    objectAliasPass, controlFlowPass, switchDispatcherPass,
    rotateSimplificationPass, commaSplitterPass, ternaryUnfoldPass,
    opaquePredicatePass, symbolicExecutionPass, junkStatementPass, deadAssignmentPass,
    deadCodePass, unusedBindingsPass, functionInlinerPass,
    astSimplificationPass, antiDebuggerPass, antiDebuggerEnhancedPass,
    scopeRenamePass, semanticRenamePass, iterativeFixedPointPass,
  ]);
  registry = reg;
  pipelineReady = true;

  // ── Pipeline ───────────────────────────────────────────────────────────────
  async function runPipeline(code, options, passes, onProgress, signal) {
    const startTime = performance.now();
    const stats = { inputBytes: new TextEncoder().encode(code).length, inputLines: code.split('\
').length, passesRun: [], passesSkipped: [], parseTime: 0, transformTime: 0, generateTime: 0, totalTime: 0 };
    const emit = (p, l) => onProgress({ progress: p, label: l });

    emit(5, 'Parsing AST\u2026');
    const parseStart = performance.now();
    let ast;
    try {
      // Always re-parse: JSON.parse(JSON.stringify(ast)) strips Babel's internal
      // path/scope linkages, so path.remove() and path.replaceWith() silently fail
      // on JSON-cloned ASTs. Re-parsing is safe and fast enough for this use case.
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
      emit(pct, 'Running: ' + pass.name + '\u2026');
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
    emit(85, 'Generating code\u2026');
    const genStart = performance.now();
    let generated;
    try {
      const result = generate(ast, { retainLines: false, concise: false, quotes: 'single', jsescOption: { minimal: true } }, code);
      generated = result.code;
    } catch(err) { stats.totalTime = performance.now() - startTime; return { ok: false, error: 'Code generation error: ' + err.message, output: null, stats }; }
    stats.generateTime = performance.now() - genStart;

    if (signal?.aborted) throw new DOMException('Pipeline aborted', 'AbortError');
    emit(90, 'Beautifying output\u2026');
    let output = generated;
    try {
      output = await prettierFormat(generated, { parser: 'babel', plugins: [parserBabel, parserEstree], printWidth: 100, tabWidth: 2, useTabs: false, semi: true, singleQuote: true, trailingComma: 'es5', bracketSpacing: true, arrowParens: 'avoid' });
    } catch(err) { emit(90, '[WARN] Prettier failed: ' + err.message); }

    stats.totalTime = performance.now() - startTime;
    stats.outputBytes = new TextEncoder().encode(output).length;
    stats.outputLines = output.split('\
').length;
    emit(100, 'Done in ' + stats.totalTime.toFixed(0) + 'ms');
    return { ok: true, output, stats };
  }

  // ── AST shallow serializer ─────────────────────────────────────────────────
  function shallowSerializeAST(ast, maxNodes) {
    const SKIP = new Set(['tokens','errors']);
    let count = 0;
    function walk(node) {
      if (!node || typeof node !== 'object' || count >= maxNodes || !node.type) return null;
      count++;
      const out = { type: node.type };
      if (node.loc) out.loc = { start: { line: node.loc.start.line } };
      if (node.value !== undefined && typeof node.value !== 'object') out.value = node.value;
      if (node.name !== undefined) out.name = node.name;
      if (node.operator !== undefined) out.operator = node.operator;
      if (node.kind !== undefined) out.kind = node.kind;
      for (const [k, v] of Object.entries(node)) {
        if (SKIP.has(k) || ['type','loc','start','end','range','extra','value','name','operator','kind'].includes(k)) continue;
        if (!v || typeof v !== 'object') continue;
        if (Array.isArray(v)) { const arr = v.map(walk).filter(Boolean); if (arr.length) out[k] = arr; }
        else if (v.type) { const child = walk(v); if (child) out[k] = child; }
      }
      return out;
    }
    return walk(ast);
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
      if (result.stats?.ast) result.stats.ast = shallowSerializeAST(result.stats.ast, 200);
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
