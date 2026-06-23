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
  function normalizeStr(str) {
    let r = str.normalize('NFKD');
    r = r.replace(/[\u0300-\u036F]/g, '');
    r = r.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFFD]/g, '');
    r = r.replace(/[\uFE00-\uFE0F]/g, '');
    const map = { '\u0430':'a','\u0435':'e','\u043E':'o','\u0440':'p','\u0441':'c','\u0443':'y','\u0445':'x','\u0410':'A','\u0412':'B','\u0415':'E','\u041A':'K','\u041C':'M','\u041D':'H','\u041E':'O','\u0420':'P','\u0421':'C','\u0422':'T','\u0425':'X','\u03B1':'a','\u03B2':'b','\u03B5':'e','\u03BF':'o','\u03BD':'v','\u03BA':'k','\u0391':'A','\u0392':'B','\u0395':'E','\u039A':'K','\u039C':'M','\u039D':'N','\u039F':'O','\u03A1':'P','\u03A4':'T','\u03A5':'Y','\u03A7':'X' };
    let out = '';
    for (const ch of r) out += map[ch] ?? ch;
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
      traverse(ast, { StringLiteral(path2) { const n = normalizeStr(path2.node.value); if (n !== path2.node.value) path2.replaceWith(t.stringLiteral(n)); } });
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

  const controlFlowPass = {
    id: 'controlFlow', name: 'Control Flow Reconstruction', priority: 22, enabled: true,
    run(ast, { log }) {
      let recovered = 0;
      traverse(ast, {
        WhileStatement(path2) {
          const test = path2.node.test;
          if (!(t.isBooleanLiteral(test, { value: true }) || t.isNumericLiteral(test, { value: 1 }))) return;
          if (!t.isBlockStatement(path2.node.body)) return;
          const r1 = tryStringSplitPattern(path2);
          if (r1) { path2.replaceWithMultiple(r1); recovered++; return; }
          const r2 = tryNumericStatePattern(path2);
          if (r2) { path2.replaceWithMultiple(r2); recovered++; }
        },
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

  // ── Register all passes ────────────────────────────────────────────────────
  const reg = new TransformRegistry();
  reg.registerAll([
    runtimePatternPass, zeroxDecoderPass, stringArrayCleanupPass,
    stringDecoderPass, xorDecodingPass, homoglyphCleanupPass,
    unicodeNormalizationPass, hexDeobfuscationPass, templateLiteralPass,
    bitwiseSimplifyPass, numericLiteralPass, propertyAccessNormPass,
    controlFlowPass, rotateSimplificationPass, commaSplitterPass,
    ternaryUnfoldPass, deadCodePass, astSimplificationPass,
    antiDebuggerPass, antiDebuggerEnhancedPass, scopeRenamePass,
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
