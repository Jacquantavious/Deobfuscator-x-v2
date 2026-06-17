'use strict';

// ════════════════════════════════════════════════════════════════════════════
// WORKER SOURCE — inlined as a string, compiled into a Blob Worker.
// Imports Babel + Prettier from esm.sh CDN inside the worker.
// ════════════════════════════════════════════════════════════════════════════

const WORKER_SOURCE = `
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
          if (!t.isIdentifier(id) || !t.isArrayExpression(init) || init.elements.length < 3) return;
          const strings = []; let sc = 0;
          for (const el of init.elements) { if (t.isStringLiteral(el)) { strings.push(el.value); sc++; } else strings.push(null); }
          if (sc / init.elements.length >= 0.8 && /^_0x[a-fA-F0-9]+$/.test(id.name)) stringArrays.set(id.name, strings);
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
          if (!t.isNumericLiteral(indexArg)) return;
          let idx = indexArg.value - offset;
          if (idx < 0 || idx >= arr.length) return;
          let str = arr[idx];
          if (str === null) return;
          if (xorKey && path2.node.arguments[1] && t.isStringLiteral(path2.node.arguments[1]))
            str = xorStrings(str, path2.node.arguments[1].value);
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
          if (!t.isIdentifier(id) || !t.isArrayExpression(init) || init.elements.length < 10) return;
          const elements = init.elements.map(el => {
            if (t.isStringLiteral(el)) return el.value;
            if (t.isNumericLiteral(el)) return el.value;
            if (t.isNullLiteral(el)) return null;
            return undefined;
          });
          const sc = elements.filter(e => typeof e === 'string').length;
          if (sc / elements.length < 0.7 || elements.some(e => e === undefined)) return;
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
          if (!raw || !/\\\\u[0-9a-fA-F]/.test(raw)) return;
          const decoded = path2.node.value;
          if (decoded === raw.slice(1, -1)) return;
          const n = t.stringLiteral(decoded);
          n.loc = path2.node.loc; n.start = path2.node.start; n.end = path2.node.end;
          path2.replaceWith(n); count++;
        },
        TemplateLiteral(path2) {
          path2.node.quasis.forEach(quasi => {
            const raw = quasi.value.raw;
            if (!raw || !/\\\\u[0-9a-fA-F]/.test(raw)) return;
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
        BinaryExpression(path2) {
          if (path2.node.operator !== '+') return;
          const { left, right } = path2.node;
          if (t.isStringLiteral(left) && t.isStringLiteral(right)) { path2.replaceWith(t.stringLiteral(left.value + right.value)); collapsed++; }
        },
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
          if (t.isBooleanLiteral(expr) || t.isNullLiteral(expr) || (t.isIdentifier(expr) && expr.name === 'undefined') || (t.isNumericLiteral(expr) && !path2.parentPath.isProgram())) { path2.remove(); removed++; }
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
    const stats = { inputBytes: new TextEncoder().encode(code).length, inputLines: code.split('\\n').length, passesRun: [], passesSkipped: [], parseTime: 0, transformTime: 0, generateTime: 0, totalTime: 0 };
    const emit = (p, l) => onProgress({ progress: p, label: l });

    emit(5, 'Parsing AST\u2026');
    const parseStart = performance.now();
    let ast;
    try {
      ast = _cache.get(code);
      if (ast) { ast = JSON.parse(JSON.stringify(ast)); emit(15, 'AST from cache'); }
      else {
        ast = parse(code, { sourceType: 'unambiguous', allowImportExportEverywhere: true, allowReturnOutsideFunction: true, allowSuperOutsideMethod: true, allowUndeclaredExports: true, errorRecovery: true, plugins: ['jsx','typescript','classProperties','classPrivateProperties','classPrivateMethods','classStaticBlock','dynamicImport','exportDefaultFrom','exportNamespaceFrom','importMeta','nullishCoalescingOperator','optionalChaining','decorators-legacy','bigInt','numericSeparator','logicalAssignment'] });
        _cache.set(code, ast);
      }
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
    stats.outputLines = output.split('\\n').length;
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
`;

// ════════════════════════════════════════════════════════════════════════════
// ZIP EXPORTER
// ════════════════════════════════════════════════════════════════════════════

class ZipExporter {
  constructor() { this._entries = []; }
  addFile(name, content) { this._entries.push({ name, content }); }
  async download(filename = 'deobfuscated.zip') {
    const bytes = await this._build();
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async _build() {
    const encoder = new TextEncoder();
    const parts = [], centralDir = [];
    let offset = 0;
    for (const entry of this._entries) {
      const nameBytes = encoder.encode(entry.name);
      const dataBytes = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
      const crc = crc32(dataBytes);
      const localHeader = buildLocalHeader(nameBytes, dataBytes, crc);
      centralDir.push({ nameBytes, dataBytes, crc, offset });
      offset += localHeader.length + dataBytes.length;
      parts.push(localHeader, dataBytes);
    }
    const cdOffset = offset;
    const cdParts = [];
    for (const entry of centralDir) cdParts.push(buildCentralDirRecord(entry.nameBytes, entry.dataBytes, entry.crc, entry.offset));
    const cdSize = cdParts.reduce((s, p) => s + p.length, 0);
    parts.push(...cdParts, buildEOCDRecord(this._entries.length, cdSize, cdOffset));
    const totalSize = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of parts) { result.set(part, pos); pos += part.length; }
    return result;
  }
}

function buildLocalHeader(nameBytes, dataBytes, crc) {
  const buf = new ArrayBuffer(30 + nameBytes.length); const view = new DataView(buf); const now = dosDateTime();
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0, true); view.setUint16(8, 0, true);
  view.setUint16(10, now.time, true); view.setUint16(12, now.date, true); view.setUint32(14, crc, true);
  view.setUint32(18, dataBytes.length, true); view.setUint32(22, dataBytes.length, true); view.setUint16(26, nameBytes.length, true); view.setUint16(28, 0, true);
  new Uint8Array(buf).set(nameBytes, 30); return new Uint8Array(buf);
}
function buildCentralDirRecord(nameBytes, dataBytes, crc, localOffset) {
  const buf = new ArrayBuffer(46 + nameBytes.length); const view = new DataView(buf); const now = dosDateTime();
  view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, 0, true); view.setUint16(10, 0, true);
  view.setUint16(12, now.time, true); view.setUint16(14, now.date, true); view.setUint32(16, crc, true);
  view.setUint32(20, dataBytes.length, true); view.setUint32(24, dataBytes.length, true); view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true); view.setUint16(32, 0, true); view.setUint16(34, 0, true); view.setUint16(36, 0, true); view.setUint32(38, 0, true); view.setUint32(42, localOffset, true);
  new Uint8Array(buf).set(nameBytes, 46); return new Uint8Array(buf);
}
function buildEOCDRecord(count, cdSize, cdOffset) {
  const buf = new ArrayBuffer(22); const view = new DataView(buf);
  view.setUint32(0, 0x06054b50, true); view.setUint16(4, 0, true); view.setUint16(6, 0, true); view.setUint16(8, count, true); view.setUint16(10, count, true); view.setUint32(12, cdSize, true); view.setUint32(16, cdOffset, true); view.setUint16(20, 0, true);
  return new Uint8Array(buf);
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
function crc32(data) { let crc = 0xffffffff; for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function dosDateTime() { const d = new Date(); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }

// ════════════════════════════════════════════════════════════════════════════
// ZIP PARSER (for drop-zone)
// ════════════════════════════════════════════════════════════════════════════

async function parseZipForJS(bytes) {
  const results = []; const decoder = new TextDecoder('utf-8'); let i = 0;
  while (i < bytes.length - 4) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4b && bytes[i+2] === 0x03 && bytes[i+3] === 0x04) {
      const view = new DataView(bytes.buffer, i);
      const compression = view.getUint16(8, true), compressedSize = view.getUint32(18, true);
      const nameLen = view.getUint16(26, true), extraLen = view.getUint16(28, true);
      const name = decoder.decode(bytes.slice(i+30, i+30+nameLen));
      const dataStart = i+30+nameLen+extraLen, dataEnd = dataStart + compressedSize;
      const compData = bytes.slice(dataStart, dataEnd);
      i = dataEnd;
      if (!name.match(/\.(js|mjs|ts|cjs)$/) || name.endsWith('/')) continue;
      try {
        let content;
        if (compression === 0) { content = decoder.decode(compData); }
        else if (compression === 8 && typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('deflate-raw'); const writer = ds.writable.getWriter();
          writer.write(compData); writer.close();
          const chunks = []; const reader = ds.readable.getReader();
          while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
          const merged = new Uint8Array(chunks.reduce((s,c) => s+c.length, 0));
          let pos = 0; for (const c of chunks) { merged.set(c, pos); pos += c.length; }
          content = decoder.decode(merged);
        } else continue;
        results.push({ name, code: content });
      } catch(_) {}
    } else if (bytes[i] === 0x50 && bytes[i+1] === 0x4b && bytes[i+2] === 0x01 && bytes[i+3] === 0x02) {
      break;
    } else i++;
  }
  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════════════════════════════

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB'], i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
function formatNumber(n) { return n.toLocaleString('en-US'); }
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch(_) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); return true; } finally { document.body.removeChild(ta); }
  }
}
function downloadFile(content, filename = 'deobfuscated.js') {
  const blob = new Blob([content], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function updateInputStats(code) {
  const lines = code.split('\n').length;
  const bytes = new TextEncoder().encode(code).length;
  const elLines = document.getElementById('stat-lines');
  const elSize  = document.getElementById('stat-size');
  if (elLines) elLines.textContent = `${formatNumber(lines)} line${lines !== 1 ? 's' : ''}`;
  if (elSize)  elSize.textContent  = formatBytes(bytes);
}
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
function flashButton(btn, message, ms = 1800) {
  const original = btn.innerHTML; btn.innerHTML = message; btn.disabled = true;
  setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, ms);
}
const el = id => document.getElementById(id);
function pad(n) { return String(n).padStart(2, '0'); }
function escapeHtml(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

// ════════════════════════════════════════════════════════════════════════════
// WORKER BRIDGE
// ════════════════════════════════════════════════════════════════════════════

class WorkerBridge {
  constructor() { this._worker = null; this._onProgress = null; this._resolvers = null; }
  _getWorker() {
    if (!this._worker) {
      const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this._worker = new Worker(url, { type: 'module' });
      this._worker.addEventListener('message', (e) => this._handleMessage(e.data));
      this._worker.addEventListener('error', (e) => { this._resolvers?.reject(new Error(e.message || 'Worker error')); this._resolvers = null; });
    }
    return this._worker;
  }
  run({ code, options = {}, passes = {}, onProgress = () => {} }) {
    return new Promise((resolve, reject) => {
      if (this._resolvers) this.abort();
      this._onProgress = onProgress;
      this._resolvers = { resolve, reject };
      this._getWorker().postMessage({ type: 'RUN', payload: { code, options, passes } });
    });
  }
  abort() {
    if (this._worker && this._resolvers) {
      this._worker.postMessage({ type: 'ABORT' });
      this._resolvers.reject(new DOMException('Aborted by user', 'AbortError'));
      this._resolvers = null; this._onProgress = null;
    }
  }
  reset() { this._worker?.terminate(); this._worker = null; this._resolvers = null; this._onProgress = null; }
  _handleMessage(data) {
    switch (data.type) {
      case 'PROGRESS': this._onProgress?.({ progress: data.progress, label: data.label }); break;
      case 'RESULT': this._resolvers?.resolve({ ok: data.ok, output: data.output, stats: data.stats, error: data.error }); this._resolvers = null; this._onProgress = null; break;
      case 'ERROR': this._resolvers?.reject(new Error(data.message)); this._resolvers = null; this._onProgress = null; break;
      case 'ABORTED': break;
    }
  }
}

class WorkerPool {
  constructor() { this._idle = []; this._busy = []; this._queue = []; this._size = 0; }
  _spawnWorker() {
    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob), { type: 'module' });
  }
  _getWorker() {
    if (this._idle.length > 0) return this._idle.pop();
    const MAX = Math.min(navigator.hardwareConcurrency ?? 2, 4);
    if (this._size < MAX) { this._size++; return this._spawnWorker(); }
    return null;
  }
  _returnWorker(w) {
    const idx = this._busy.indexOf(w);
    if (idx >= 0) this._busy.splice(idx, 1);
    this._idle.push(w);
    this._drainQueue();
  }
  _drainQueue() {
    while (this._queue.length > 0) {
      const w = this._getWorker(); if (!w) break;
      const { job, resolve, reject } = this._queue.shift();
      this._runOnWorker(w, job, resolve, reject);
    }
  }
  _runOnWorker(worker, job, resolve, reject) {
    this._busy.push(worker);
    const onMessage = (e) => {
      const { type, ...rest } = e.data;
      if (type === 'PROGRESS') { job.onProgress?.(rest); return; }
      if (type === 'RESULT' || type === 'ERROR' || type === 'ABORTED') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        this._returnWorker(worker);
        if (type === 'RESULT') resolve({ ok: rest.ok, output: rest.output, stats: rest.stats, error: rest.error });
        else reject(new Error(rest.message ?? 'Worker error'));
      }
    };
    const onError = (e) => { worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); this._returnWorker(worker); reject(new Error(e.message ?? 'Worker error')); };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'RUN', payload: job.payload });
  }
  run(job) {
    return new Promise((resolve, reject) => {
      const w = this._getWorker();
      if (w) this._runOnWorker(w, job, resolve, reject);
      else this._queue.push({ job, resolve, reject });
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PROGRESS MANAGER
// ════════════════════════════════════════════════════════════════════════════

class ProgressManager {
  constructor() {
    this._fill      = el('progress-fill');
    this._label     = el('progress-label');
    this._container = el('progress-container');
    this._statPasses = el('stat-passes');
  }
  set(pct, label) {
    if (this._fill)  this._fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    if (this._label) this._label.textContent = label;
    if (pct > 0 && pct < 100) this._container?.classList.add('processing');
    else this._container?.classList.remove('processing');
  }
  reset() { this.set(0, 'Idle'); }
  complete() { this.set(100, 'Done'); setTimeout(() => this.reset(), 2500); }
  error(msg = 'Error') { this.set(0, msg); this._container?.classList.remove('processing'); }
  setPassCount(n) { if (this._statPasses) { this._statPasses.textContent = `${n} pass${n !== 1 ? 'es' : ''}`; this._statPasses.classList.toggle('active', n > 0); } }
}

// ════════════════════════════════════════════════════════════════════════════
// CONSOLE LOGGER
// ════════════════════════════════════════════════════════════════════════════

class ConsoleLogger {
  constructor() {
    this._logEl  = el('atab-log');
    this._passEl = el('atab-passes');
    this._entries = 0;
  }
  log(level, message) {
    if (this._entries >= 500) this._logEl?.firstChild?.remove();
    const now = new Date();
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const entry = document.createElement('div');
    entry.className = `console-entry console-entry--${level}`;
    entry.innerHTML = `<span class="console-time">${time}</span><span class="console-tag tag--${level}">${level.toUpperCase()}</span><span class="console-msg">${escapeHtml(message)}</span>`;
    this._logEl?.appendChild(entry);
    this._entries++;
    const body = el('analysis-body'); if (body) body.scrollTop = body.scrollHeight;
  }
  info(msg)    { this.log('info', msg); }
  success(msg) { this.log('success', msg); }
  warn(msg)    { this.log('warn', msg); }
  error(msg)   { this.log('error', msg); }
  showPassResults(passesRun, passesSkipped) {
    if (!this._passEl) return;
    let html = '';
    if (passesRun.length > 0) {
      const maxDur = Math.max(...passesRun.map(p => p.duration), 1);
      const totalDur = passesRun.reduce((s, p) => s + p.duration, 0);
      html += `<div class="pass-summary"><span class="pass-summary-stat">${passesRun.length} passes</span><span class="pass-summary-stat">${totalDur.toFixed(0)}ms total</span></div>`;
      for (const p of passesRun) {
        const pct = Math.max(2, (p.duration / maxDur) * 100);
        const cls = p.duration > 500 ? 'tag--warn' : 'tag--pass';
        html += `<div class="console-entry pass-result-row"><span class="console-tag ${cls}">PASS</span><span class="console-msg pass-name">${escapeHtml(p.name)}</span><span class="pass-timing">${p.duration.toFixed(1)}ms</span><span class="pass-bar-track"><span class="pass-bar-fill" style="width:${pct.toFixed(1)}%"></span></span></div>`;
      }
    }
    for (const p of passesSkipped) html += `<div class="console-entry console-entry--warn"><span class="console-tag tag--warn">SKIP</span><span class="console-msg">${escapeHtml(p.id)} — ${escapeHtml(p.reason)}</span></div>`;
    if (!html) html = '<div class="console-entry"><span class="console-msg" style="color:var(--text-muted)">No passes ran this session.</span></div>';
    this._passEl.innerHTML = html;
  }
  clear() { if (this._logEl) { this._logEl.innerHTML = ''; this._entries = 0; } this.info('Console cleared.'); }
}

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL
// ════════════════════════════════════════════════════════════════════════════

class SettingsPanel {
  constructor() {
    this._panel   = el('settings-panel');
    this._overlay = el('settings-overlay');
    this._defaults = this._captureDefaults();
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.isOpen()) this.close(); });
  }
  open()  { this._panel?.classList.add('open'); this._overlay?.classList.add('visible'); el('btn-settings')?.setAttribute('aria-expanded', 'true'); }
  close() { this._panel?.classList.remove('open'); this._overlay?.classList.remove('visible'); el('btn-settings')?.setAttribute('aria-expanded', 'false'); }
  isOpen() { return this._panel?.classList.contains('open') ?? false; }
  toggle() { this.isOpen() ? this.close() : this.open(); }
  getPassState() {
    const state = {};
    document.querySelectorAll('.toggle-input[data-pass]').forEach(input => { state[input.dataset.pass] = input.checked; });
    return state;
  }
  getOptions() {
    const opts = {};
    document.querySelectorAll('.toggle-input[data-option]').forEach(input => { opts[input.dataset.option] = input.checked; });
    return opts;
  }
  resetDefaults() {
    for (const [id, value] of Object.entries(this._defaults)) {
      const el2 = document.querySelector(`[data-pass="${id}"], [data-option="${id}"]`);
      if (el2) el2.checked = value;
    }
  }
  _captureDefaults() {
    const defaults = {};
    document.querySelectorAll('.toggle-input').forEach(input => { const key = input.dataset.pass ?? input.dataset.option; if (key) defaults[key] = input.checked; });
    return defaults;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// DIFF VIEWER
// ════════════════════════════════════════════════════════════════════════════

class DiffViewer {
  constructor(containerEl) { this._container = containerEl; }
  render(originalCode, transformedCode) {
    this._container.innerHTML = '';
    const origLines = originalCode.split('\n'), newLines = transformedCode.split('\n');
    const hunks = computeDiff(origLines, newLines);
    const stats = document.createElement('div'); stats.className = 'diff-stats';
    const added = hunks.filter(h => h.type === 'add').length, removed = hunks.filter(h => h.type === 'remove').length, changed = hunks.filter(h => h.type === 'change').length;
    stats.innerHTML = `<span class="diff-stat diff-stat--add">+${added} added</span><span class="diff-stat diff-stat--remove">−${removed} removed</span><span class="diff-stat diff-stat--change">~${changed} changed</span><span class="diff-stat diff-stat--total">${origLines.length} → ${newLines.length} lines</span>`;
    this._container.appendChild(stats);
    const table = document.createElement('table'); table.className = 'diff-table';
    const tbody = document.createElement('tbody');
    let oi = 1, ni = 1;
    for (const hunk of hunks) {
      if (hunk.type === 'equal') { for (const line of hunk.lines) { tbody.appendChild(makeDiffRow('equal', oi++, ni++, line, line)); } }
      else if (hunk.type === 'remove') { for (const line of hunk.lines) { tbody.appendChild(makeDiffRow('remove', oi++, null, line, '')); } }
      else if (hunk.type === 'add') { for (const line of hunk.lines) { tbody.appendChild(makeDiffRow('add', null, ni++, '', line)); } }
      else if (hunk.type === 'change') {
        for (const line of hunk.oldLines) { tbody.appendChild(makeDiffRow('remove', oi++, null, line, '')); }
        for (const line of hunk.newLines) { tbody.appendChild(makeDiffRow('add', null, ni++, '', line)); }
      }
    }
    table.appendChild(tbody); this._container.appendChild(table);
  }
  clear() { this._container.innerHTML = '<div class="diff-empty">Run deobfuscation to see diff.</div>'; }
}

function makeDiffRow(type, oldNum, newNum, oldText, newText) {
  const tr = document.createElement('tr'); tr.className = `diff-row diff-row--${type}`;
  const mkTd = (cls, text) => { const td = document.createElement('td'); td.className = cls; td.textContent = text ?? ''; return td; };
  tr.appendChild(mkTd('diff-linenum', oldNum != null ? oldNum : ''));
  tr.appendChild(mkTd('diff-cell diff-cell--old', oldText));
  tr.appendChild(mkTd('diff-linenum', newNum != null ? newNum : ''));
  tr.appendChild(mkTd('diff-cell diff-cell--new', newText));
  return tr;
}
function computeDiff(a, b) { return a.length + b.length > 5000 ? simpleDiff(a, b) : lcsDiff(a, b); }
function lcsDiff(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m+1 }, () => new Int32Array(n+1));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i][j-1], dp[i-1][j]);
  const hunks = []; let i = m, j = n; const ops = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { ops.push({ type: 'equal', old: a[i-1], new: b[j-1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.push({ type: 'add', new: b[j-1] }); j--; }
    else { ops.push({ type: 'remove', old: a[i-1] }); i--; }
  }
  ops.reverse();
  let cur = null;
  for (const op of ops) {
    if (!cur || cur.type !== op.type) {
      cur = op.type === 'equal' ? { type: 'equal', lines: [] } : op.type === 'add' ? { type: 'add', lines: [] } : { type: 'remove', lines: [] };
      hunks.push(cur);
    }
    if (op.type === 'equal') cur.lines.push(op.old);
    else if (op.type === 'add') cur.lines.push(op.new);
    else cur.lines.push(op.old);
  }
  return collapseContext(hunks, 3);
}
function collapseContext(hunks, ctx) {
  const result = [];
  for (const hunk of hunks) {
    if (hunk.type !== 'equal') { result.push(hunk); continue; }
    if (hunk.lines.length <= ctx * 2 + 1) { result.push(hunk); continue; }
    result.push({ type: 'equal', lines: hunk.lines.slice(0, ctx) });
    result.push({ type: 'equal', lines: [`  ··· ${hunk.lines.length - ctx*2} unchanged lines ···`] });
    result.push({ type: 'equal', lines: hunk.lines.slice(-ctx) });
  }
  return result;
}
function simpleDiff(a, b) {
  const hunks = []; const maxLines = Math.max(a.length, b.length); const chunkSize = 50;
  for (let i = 0; i < maxLines; i += chunkSize) {
    const ac = a.slice(i, i+chunkSize), bc = b.slice(i, i+chunkSize);
    if (ac.join('\n') === bc.join('\n')) hunks.push({ type: 'equal', lines: ac });
    else { if (ac.length) hunks.push({ type: 'remove', lines: ac }); if (bc.length) hunks.push({ type: 'add', lines: bc }); }
  }
  return hunks;
}

// ════════════════════════════════════════════════════════════════════════════
// TRANSFORM LOG
// ════════════════════════════════════════════════════════════════════════════

class TransformLog {
  constructor(containerEl) { this._container = containerEl; this._sessions = []; }
  addSession(passesRun, passesSkipped, totalMs) {
    this._sessions.unshift({ passesRun, passesSkipped, totalMs, ts: Date.now() });
    if (this._sessions.length > 10) this._sessions.pop();
    this.render();
  }
  render() {
    this._container.innerHTML = '';
    if (this._sessions.length === 0) { this._container.innerHTML = '<div class="tlog-empty">No pipeline runs yet.</div>'; return; }
    for (const session of this._sessions) {
      const sessionEl = document.createElement('div'); sessionEl.className = 'tlog-session';
      const header = document.createElement('div'); header.className = 'tlog-session-header';
      header.innerHTML = `<span class="tlog-session-title">Pipeline run — ${formatTime(session.ts)}</span><span class="tlog-session-total">${session.totalMs?.toFixed(0) ?? '?'}ms total</span>`;
      sessionEl.appendChild(header);
      const list = document.createElement('div'); list.className = 'tlog-list';
      const maxDur = Math.max(...(session.passesRun.map(p => p.duration) || [1]), 1);
      for (const pass of session.passesRun) {
        const pct = Math.max(2, (pass.duration / maxDur) * 100);
        const sc = pass.duration > 500 ? 'tlog-status--warn' : 'tlog-status--ok';
        const row = document.createElement('div'); row.className = 'tlog-row';
        row.innerHTML = `<div class="tlog-pass-header"><span class="tlog-status ${sc}">✓</span><span class="tlog-pass-name">${escapeHtml(pass.name)}</span><span class="tlog-pass-id">${escapeHtml(pass.id)}</span><span class="tlog-pass-dur">${pass.duration.toFixed(1)}ms</span></div><div class="tlog-bar-track"><div class="tlog-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>${pass.messages?.length ? `<div class="tlog-messages">${pass.messages.map(m => `<div class="tlog-msg">${escapeHtml(m)}</div>`).join('')}</div>` : ''}`;
        list.appendChild(row);
      }
      for (const pass of session.passesSkipped) {
        const row = document.createElement('div'); row.className = 'tlog-row tlog-row--skip';
        row.innerHTML = `<div class="tlog-pass-header"><span class="tlog-status tlog-status--skip">⊘</span><span class="tlog-pass-name">${escapeHtml(pass.id)}</span><span class="tlog-skip-reason">${escapeHtml(pass.reason)}</span></div>`;
        list.appendChild(row);
      }
      sessionEl.appendChild(list); this._container.appendChild(sessionEl);
    }
  }
  clear() { this._sessions = []; this.render(); }
}

// ════════════════════════════════════════════════════════════════════════════
// AST VISUALIZER
// ════════════════════════════════════════════════════════════════════════════

const TYPE_COLORS = { Program:'#00ff9d',FunctionDeclaration:'#80ccff',ArrowFunctionExpression:'#80ccff',FunctionExpression:'#80ccff',VariableDeclaration:'#4db8ff',VariableDeclarator:'#4db8ff',ReturnStatement:'#ff9966',IfStatement:'#ffe566',WhileStatement:'#ffe566',ForStatement:'#ffe566',SwitchStatement:'#ffe566',BlockStatement:'#8899aa',ExpressionStatement:'#8899aa',CallExpression:'#ff80aa',MemberExpression:'#c8d8e8',AssignmentExpression:'#cc99ff',BinaryExpression:'#cc99ff',LogicalExpression:'#cc99ff',ConditionalExpression:'#ffcc66',StringLiteral:'#ffe566',NumericLiteral:'#ff9966',BooleanLiteral:'#ff9966',NullLiteral:'#8899aa',Identifier:'#c8d8e8',TemplateLiteral:'#ffe566' };

class ASTVisualizer {
  constructor(containerEl) { this._container = containerEl; this._nodeCount = 0; }
  render(ast) {
    this._nodeCount = 0; this._container.innerHTML = '';
    if (!ast) { this._container.innerHTML = '<div class="ast-empty">No AST available. Run deobfuscation first.</div>'; return; }
    const statsBar = document.createElement('div'); statsBar.className = 'ast-stats-bar'; this._container.appendChild(statsBar);
    const tree = document.createElement('div'); tree.className = 'ast-tree'; this._container.appendChild(tree);
    const root = this._renderNode(ast, 0); if (root) tree.appendChild(root);
    statsBar.innerHTML = `<span class="ast-stat">Nodes: <b>${this._nodeCount.toLocaleString()}</b></span><span class="ast-stat">Type: <b>${ast.type}</b></span><button class="ast-btn" id="ast-expand-all">Expand All</button><button class="ast-btn" id="ast-collapse-all">Collapse All</button>`;
    statsBar.querySelector('#ast-expand-all')?.addEventListener('click', () => { tree.querySelectorAll('.ast-children').forEach(e => e.classList.remove('collapsed')); tree.querySelectorAll('.ast-toggle').forEach(e => e.textContent = '▾'); });
    statsBar.querySelector('#ast-collapse-all')?.addEventListener('click', () => { tree.querySelectorAll('.ast-children').forEach(e => e.classList.add('collapsed')); tree.querySelectorAll('.ast-toggle').forEach(e => e.textContent = '▸'); });
  }
  _renderNode(node, depth) {
    if (this._nodeCount >= 2000 || !node || typeof node !== 'object' || !node.type) return null;
    this._nodeCount++;
    const nodeEl = document.createElement('div'); nodeEl.className = 'ast-node';
    const color = TYPE_COLORS[node.type] ?? '#8899aa';
    const preview = this._getPreview(node);
    const children = this._getChildren(node);
    const hasChildren = children.length > 0;
    const header = document.createElement('div'); header.className = 'ast-node-header';
    header.innerHTML = `${hasChildren ? '<span class="ast-toggle">▾</span>' : '<span class="ast-leaf">·</span>'}<span class="ast-type" style="color:${color}">${escapeHtml(node.type)}</span>${preview ? `<span class="ast-preview">${escapeHtml(preview)}</span>` : ''}${node.loc ? `<span class="ast-loc">L${node.loc.start.line}</span>` : ''}`;
    nodeEl.appendChild(header);
    if (hasChildren) {
      const childrenEl = document.createElement('div'); childrenEl.className = 'ast-children';
      if (depth > 4) childrenEl.classList.add('collapsed');
      for (const { key, child } of children) {
        if (this._nodeCount >= 2000) { const te = document.createElement('div'); te.className = 'ast-truncated'; te.textContent = `… (render limit reached)`; childrenEl.appendChild(te); break; }
        const keyEl = document.createElement('div'); keyEl.className = 'ast-key'; keyEl.textContent = key; childrenEl.appendChild(keyEl);
        if (Array.isArray(child)) { child.forEach((c, i) => { const cn = this._renderNode(c, depth+1); if (cn) { cn.dataset.arrayIndex = i; childrenEl.appendChild(cn); } }); }
        else { const cn = this._renderNode(child, depth+1); if (cn) childrenEl.appendChild(cn); }
      }
      nodeEl.appendChild(childrenEl);
      header.querySelector('.ast-toggle')?.addEventListener('click', (e) => { e.stopPropagation(); const collapsed = childrenEl.classList.toggle('collapsed'); e.currentTarget.textContent = collapsed ? '▸' : '▾'; });
    }
    return nodeEl;
  }
  _getPreview(node) {
    switch(node.type) {
      case 'StringLiteral': return `"${String(node.value ?? '').substring(0, 40)}${(node.value?.length ?? 0) > 40 ? '…' : ''}"`;
      case 'NumericLiteral': return String(node.value);
      case 'BooleanLiteral': return String(node.value);
      case 'NullLiteral': return 'null';
      case 'Identifier': return node.name;
      case 'VariableDeclaration': return node.kind;
      case 'BinaryExpression': case 'LogicalExpression': case 'AssignmentExpression': return node.operator;
      default: return '';
    }
  }
  _getChildren(node) {
    const SKIP = new Set(['type','start','end','loc','range','extra','trailingComments','leadingComments','innerComments','tokens']);
    const children = [];
    for (const [key, val] of Object.entries(node)) {
      if (SKIP.has(key) || val === null || val === undefined || typeof val !== 'object') continue;
      if (Array.isArray(val)) { const nodes = val.filter(v => v && typeof v === 'object' && v.type); if (nodes.length > 0) children.push({ key: `${key}[${nodes.length}]`, child: nodes }); }
      else if (val.type) children.push({ key, child: val });
    }
    return children;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BATCH PANEL
// ════════════════════════════════════════════════════════════════════════════

class BatchPanel {
  constructor(containerEl, { onRun, onCancel } = {}) {
    this._container = containerEl;
    this._onRun = onRun ?? (() => {});
    this._onCancel = onCancel ?? (() => {});
    this._files = []; this._results = []; this._running = false;
    this._render();
  }
  setFiles(files) { this._files = files.map(f => ({ ...f, status: 'pending' })); this._results = []; this._renderFileList(); }
  updateProgress({ done, total, name }) {
    const f = this._files.find(f => f.name === name); if (f) f.status = 'done';
    this._renderFileList();
    const bar = this._container.querySelector('#batch-progress-fill');
    const label = this._container.querySelector('#batch-progress-label');
    if (bar) bar.style.width = `${(done / total) * 100}%`;
    if (label) label.textContent = `${done} / ${total} files`;
  }
  setResults(results) { this._results = results; this._running = false; this._renderResults(); }
  setRunning(running) {
    this._running = running;
    const btn = this._container.querySelector('#batch-run-btn');
    if (btn) { btn.textContent = running ? '⏹ Cancel' : '▶ Run Batch'; btn.className = running ? 'btn btn-danger' : 'btn btn-primary'; }
  }
  _render() {
    this._container.innerHTML = `<div class="batch-header"><h3 class="batch-title">Batch Processing</h3><div class="batch-controls"><button class="btn btn-primary" id="batch-run-btn" disabled>▶ Run Batch</button><button class="btn btn-ghost" id="batch-clear-btn">✕ Clear</button><button class="btn btn-ghost" id="batch-zip-btn" disabled>⬇ Export ZIP</button></div></div><div class="batch-progress-bar" id="batch-progress-bar" style="display:none"><div class="batch-progress-track"><div class="batch-progress-fill" id="batch-progress-fill" style="width:0%"></div></div><span class="batch-progress-label" id="batch-progress-label">0 / 0 files</span></div><div class="batch-file-list" id="batch-file-list"><div class="batch-empty">Drop .js or .zip files to start batch processing</div></div><div class="batch-results" id="batch-results" style="display:none"></div>`;
    this._container.querySelector('#batch-run-btn')?.addEventListener('click', () => { if (this._running) { this._onCancel(); } else { this._onRun(this._files); this.setRunning(true); const bar = this._container.querySelector('#batch-progress-bar'); if (bar) bar.style.display = ''; } });
    this._container.querySelector('#batch-clear-btn')?.addEventListener('click', () => { this._files = []; this._results = []; this._running = false; this._renderFileList(); const r = this._container.querySelector('#batch-results'); if (r) r.style.display = 'none'; const b = this._container.querySelector('#batch-progress-bar'); if (b) b.style.display = 'none'; });
    this._container.querySelector('#batch-zip-btn')?.addEventListener('click', () => this._exportZip());
  }
  _renderFileList() {
    const list = this._container.querySelector('#batch-file-list'); if (!list) return;
    const btn = this._container.querySelector('#batch-run-btn'); if (btn) btn.disabled = this._files.length === 0;
    if (this._files.length === 0) { list.innerHTML = '<div class="batch-empty">Drop .js or .zip files to start batch processing</div>'; return; }
    list.innerHTML = this._files.map((f, i) => `<div class="batch-file-row batch-file-row--${f.status}"><span class="batch-file-icon">${f.status==='done'?'✓':f.status==='error'?'✗':'○'}</span><span class="batch-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span><span class="batch-file-size">${formatBytes(f.code?.length ?? 0)}</span><button class="batch-file-remove" data-idx="${i}" title="Remove">✕</button></div>`).join('');
    list.querySelectorAll('.batch-file-remove').forEach(btn => btn.addEventListener('click', () => { this._files.splice(parseInt(btn.dataset.idx, 10), 1); this._renderFileList(); }));
  }
  _renderResults() {
    const el2 = this._container.querySelector('#batch-results'); if (!el2) return;
    const ok = this._results.filter(r => r.ok).length, fail = this._results.length - ok;
    el2.style.display = '';
    el2.innerHTML = `<div class="batch-results-header"><span class="batch-results-stat batch-results-stat--ok">✓ ${ok} succeeded</span>${fail > 0 ? `<span class="batch-results-stat batch-results-stat--fail">✗ ${fail} failed</span>` : ''}</div>${this._results.map(r => `<div class="batch-result-row batch-result-row--${r.ok?'ok':'fail'}"><span class="batch-result-icon">${r.ok?'✓':'✗'}</span><span class="batch-result-name">${escapeHtml(r.name)}</span>${r.ok ? `<span class="batch-result-lines">${r.stats?.outputLines?.toLocaleString() ?? '?'} lines</span><button class="btn btn-sm batch-dl-btn" data-name="${escapeHtml(r.name)}">⬇</button>` : `<span class="batch-result-error">${escapeHtml(r.error ?? 'Error')}</span>`}</div>`).join('')}`;
    el2.querySelectorAll('.batch-dl-btn').forEach(btn => btn.addEventListener('click', () => { const result = this._results.find(r => r.name === btn.dataset.name); if (result?.output) downloadFile(result.output, result.name.replace(/\.js$/, '') + '.deobfuscated.js'); }));
    const zipBtn = this._container.querySelector('#batch-zip-btn'); if (zipBtn) zipBtn.disabled = !this._results.some(r => r.ok);
  }
  async _exportZip() {
    const exporter = new ZipExporter();
    for (const result of this._results) { if (result.ok && result.output) exporter.addFile(result.name.replace(/\.js$/, '') + '.deobfuscated.js', result.output); }
    exporter.addFile('manifest.json', JSON.stringify({ tool: 'Deobfuscator-X v3', exported: new Date().toISOString(), files: this._results.map(r => ({ name: r.name, ok: r.ok, lines: r.stats?.outputLines, error: r.error })) }, null, 2));
    await exporter.download('deobfuscated-batch.zip');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// DROP ZONE
// ════════════════════════════════════════════════════════════════════════════

class DropZone {
  constructor(el2, { onSingleFile, onBatchFiles, onError } = {}) {
    this._el = el2;
    this._onSingleFile = onSingleFile ?? (() => {});
    this._onBatchFiles = onBatchFiles ?? (() => {});
    this._onError = onError ?? console.error;
    this._dragDepth = 0;
    this._el.addEventListener('dragenter', e => { e.preventDefault(); this._dragDepth++; if (this._dragDepth === 1) this._el.classList.add('drag-over'); });
    this._el.addEventListener('dragleave', e => { e.preventDefault(); this._dragDepth--; if (this._dragDepth === 0) this._el.classList.remove('drag-over'); });
    this._el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    this._el.addEventListener('drop', async e => {
      e.preventDefault(); this._dragDepth = 0; this._el.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const jsFiles = [], errors = [];
      for (const file of files) {
        if (file.name.endsWith('.zip')) {
          try { const extracted = await parseZipForJS(new Uint8Array(await file.arrayBuffer())); jsFiles.push(...extracted); } catch(err) { errors.push('Failed to extract ' + file.name + ': ' + err.message); }
        } else if (/\.(js|mjs|cjs|ts)$/.test(file.name) || files.length === 1) {
          try { jsFiles.push({ name: file.name, code: await readFileAsText(file) }); } catch(err) { errors.push('Failed to read ' + file.name + ': ' + err.message); }
        }
      }
      for (const e of errors) this._onError(e);
      if (jsFiles.length === 0) return;
      if (jsFiles.length === 1) this._onSingleFile(jsFiles[0].name, jsFiles[0].code);
      else this._onBatchFiles(jsFiles);
    });
  }
}
function readFileAsText(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('FileReader error')); r.readAsText(file, 'utf-8'); });
}

// ════════════════════════════════════════════════════════════════════════════
// BATCH PROCESSOR
// ════════════════════════════════════════════════════════════════════════════

class BatchProcessor {
  constructor(pool) { this._pool = pool; }
  async run(files, passes, options, onProgress) {
    const total = files.length; let done = 0;
    return Promise.all(files.map(file =>
      this._pool.run({ payload: { code: file.code, options, passes }, onProgress: () => {} })
        .then(result => { done++; onProgress?.({ done, total, name: file.name }); return { name: file.name, ...result }; })
        .catch(err => { done++; onProgress?.({ done, total, name: file.name }); return { name: file.name, ok: false, output: null, error: err.message, stats: {} }; })
    ));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// DEMO CODE
// ════════════════════════════════════════════════════════════════════════════

const DEMO_CODE = `// Deobfuscator-X — paste your obfuscated code here.
// Below is a sample obfuscated snippet to try:

var _0x1a2b = ['\\x68\\x65\\x6c\\x6c\\x6f', '\\x77\\x6f\\x72\\x6c\\x64'];
(function(a, b) {
  var c = function(d) {
    while (--d) { a['push'](a['shift']()); }
  };
  c(++b);
}(_0x1a2b, 0x1a4));

var _0x3c4d = function(a, b) {
  a = a - 0x0;
  return _0x1a2b[a];
};

if (0x1 == 0x1) {
  var msg = _0x3c4d('0x0') + ' ' + _0x3c4d('0x1');
  debugger;
  console['log'](msg);
}

var encoded = '\\u0068\\u0065\\u006c\\u006c\\u006f';
var hex_val = 0xFF + 0x1b;
var deadBranch = false ? 'unreachable' : 'reachable';
setInterval(function() { debugger; }, 500);
`;

// ════════════════════════════════════════════════════════════════════════════
// MONACO EDITOR MANAGER
// ════════════════════════════════════════════════════════════════════════════

class EditorManager {
  constructor() { this.inputEditor = null; this.outputEditor = null; this._monaco = null; this._resizeObs = null; this._isDragging = false; }

  async init({ inputEl, outputEl }) {
    return new Promise((resolve, reject) => {
      require(['vs/editor/editor.main'], (monaco) => {
        try {
          this._monaco = monaco;
          this._registerThemes(monaco);

          const common = {
            language: 'javascript',
            theme: 'deobfuscator-dark',
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontLigatures: true,
            lineNumbers: 'on',
            minimap: { enabled: true, maxColumn: 80 },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            renderWhitespace: 'boundary',
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true, indentation: true },
            smoothScrolling: true,
            cursorBlinking: 'phase',
            cursorSmoothCaretAnimation: 'on',
            padding: { top: 12, bottom: 12 },
            automaticLayout: false,
            largeFileOptimizations: true,
          };

          this.inputEditor = monaco.editor.create(inputEl, { ...common, value: DEMO_CODE, readOnly: false });
          this.outputEditor = monaco.editor.create(outputEl, { ...common, value: '', readOnly: true, domReadOnly: true });

          this._resizeObs = new ResizeObserver(() => { this.inputEditor?.layout(); this.outputEditor?.layout(); });
          this._resizeObs.observe(inputEl);
          this._resizeObs.observe(outputEl);
          this._initResizeHandle();

          resolve({ inputEditor: this.inputEditor, outputEditor: this.outputEditor });
        } catch(err) { reject(err); }
      });
    });
  }

  _registerThemes(monaco) {
    monaco.editor.defineTheme('deobfuscator-dark', {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '4a5a6a', fontStyle: 'italic' },
        { token: 'keyword', foreground: '00ff9d', fontStyle: 'bold' },
        { token: 'string', foreground: 'ffe566' },
        { token: 'number', foreground: 'ff9966' },
        { token: 'regexp', foreground: 'ff6680' },
        { token: 'delimiter', foreground: '8899aa' },
        { token: 'identifier', foreground: 'c8d8e8' },
        { token: 'type', foreground: '4db8ff' },
        { token: 'variable', foreground: 'e0d0ff' },
        { token: 'function', foreground: '80ccff' },
      ],
      colors: {
        'editor.background': '#0a0d0f', 'editor.foreground': '#c8d8e8',
        'editorLineNumber.foreground': '#2e3f50', 'editorLineNumber.activeForeground': '#00ff9d',
        'editor.selectionBackground': '#00ff9d22', 'editor.lineHighlightBackground': '#0e1215',
        'editorCursor.foreground': '#00ff9d', 'editor.findMatchBackground': '#ffe56640',
        'editorBracketMatch.background': '#00ff9d20', 'editorBracketMatch.border': '#00ff9d',
        'editorWidget.background': '#0e1215', 'editorWidget.border': '#1e2830',
        'input.background': '#141a1f', 'input.border': '#253040',
        'scrollbarSlider.background': '#25304080', 'scrollbarSlider.hoverBackground': '#2e3f5099',
      },
    });
    monaco.editor.defineTheme('deobfuscator-light', {
      base: 'vs', inherit: true,
      rules: [{ token: 'comment', foreground: '6a7a8a', fontStyle: 'italic' }, { token: 'keyword', foreground: '007a48', fontStyle: 'bold' }, { token: 'string', foreground: '8b5000' }, { token: 'number', foreground: 'c05000' }],
      colors: { 'editor.background': '#fafbfc', 'editor.foreground': '#0e1a24', 'editorLineNumber.foreground': '#b8c4d0', 'editorLineNumber.activeForeground': '#007a48', 'editor.selectionBackground': '#007a4820', 'editorCursor.foreground': '#007a48' },
    });
  }

  setTheme(isDark) { this._monaco?.editor.setTheme(isDark ? 'deobfuscator-dark' : 'deobfuscator-light'); }

  setOutput(code) {
    if (!this.outputEditor) return;
    if (code.length > 500000) {
      const model = this.outputEditor.getModel(); model.setValue('');
      const CHUNK = 100000; let offset = 0;
      const pushChunk = () => {
        if (offset >= code.length) return;
        const chunk = code.slice(offset, offset + CHUNK);
        const lc = model.getLineCount(), lastCol = model.getLineLength(lc) + 1;
        model.applyEdits([{ range: { startLineNumber: lc, startColumn: lastCol, endLineNumber: lc, endColumn: lastCol }, text: chunk }]);
        offset += CHUNK;
        if (offset < code.length) requestAnimationFrame(pushChunk);
      };
      pushChunk();
    } else { this.outputEditor.getModel().setValue(code); }
    this.outputEditor.revealLine(1);
  }

  getInput() { return this.inputEditor?.getValue() ?? ''; }
  setInput(code) { this.inputEditor?.setValue(code); }
  clear() { this.inputEditor?.setValue(''); this.outputEditor?.getModel()?.setValue(''); }

  _initResizeHandle() {
    const handle = el('resize-handle'), workspace = el('workspace'), inputPane = el('input-pane'), outputPane = el('output-pane');
    if (!handle || !workspace) return;
    let startX, startLeftW, totalW;
    const onMouseMove = (e) => {
      if (!this._isDragging) return;
      const dx = e.clientX - startX;
      const leftPct = Math.max(20, Math.min(80, ((startLeftW + dx) / totalW) * 100));
      inputPane.style.flex = `0 0 ${leftPct}%`; outputPane.style.flex = `1 1 0`;
      this.inputEditor?.layout(); this.outputEditor?.layout();
    };
    const onMouseUp = () => { this._isDragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };
    handle.addEventListener('mousedown', (e) => { this._isDragging = true; startX = e.clientX; startLeftW = inputPane.getBoundingClientRect().width; totalW = workspace.getBoundingClientRect().width; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp); e.preventDefault(); });
  }

  destroy() { this._resizeObs?.disconnect(); this.inputEditor?.dispose(); this.outputEditor?.dispose(); }
}

// ════════════════════════════════════════════════════════════════════════════
// APPLICATION BOOTSTRAP
// ════════════════════════════════════════════════════════════════════════════

let outputCode = '', inputCode = '', isProcessing = false, isDarkTheme = true;
let editors, logger, settings, progress, bridge, pool;
let astViz, diffView, tlogView, batchPanel, dropZone;

async function init() {
  logger   = new ConsoleLogger();
  settings = new SettingsPanel();
  progress = new ProgressManager();
  bridge   = new WorkerBridge();
  pool     = new WorkerPool();

  logger.info('Initializing Deobfuscator-X v3…');

  editors = new EditorManager();
  try {
    await editors.init({ inputEl: el('input-editor-container'), outputEl: el('output-editor-container') });
  } catch(err) { logger.error(`Failed to initialize Monaco: ${err.message}`); return; }

  editors.inputEditor.onDidChangeModelContent(debounce(() => {
    inputCode = editors.getInput(); updateInputStats(inputCode); updateInputMeta();
  }, 300));

  inputCode = editors.getInput(); updateInputStats(inputCode); updateInputMeta();

  mountAnalysisComponents();

  const inputPane = el('input-pane');
  if (inputPane) {
    dropZone = new DropZone(inputPane, {
      onSingleFile: (name, code) => { editors.setInput(code); logger.info(`Loaded: ${name} (${formatBytes(code.length)})`); },
      onBatchFiles: (files) => { logger.info(`${files.length} files dropped — opening Batch tab`); switchAnalysisTab('batch'); batchPanel?.setFiles(files); },
      onError: (msg) => logger.error(msg),
    });
  }

  bindButtons();
  initAnalysisTabs();
  initAnalysisResize();

  logger.success('Deobfuscator-X v3 ready — 18 passes loaded');
  logger.info('Drop a .js file to load it · Ctrl+Enter to deobfuscate · Ctrl+, for settings');
}

function mountAnalysisComponents() {
  const diffEl  = el('atab-diff');
  const tlogEl  = el('atab-tlog');
  const astEl   = el('atab-ast-tree');
  const batchEl = el('batch-panel-root');
  if (diffEl)  diffView  = new DiffViewer(diffEl);
  if (tlogEl)  tlogView  = new TransformLog(tlogEl);
  if (astEl)   astViz    = new ASTVisualizer(astEl);
  if (batchEl) batchPanel = new BatchPanel(batchEl, { onRun: (files) => runBatch(files), onCancel: () => {} });
}

function initAnalysisTabs() {
  document.querySelectorAll('.analysis-tab').forEach(tab => tab.addEventListener('click', () => switchAnalysisTab(tab.dataset.atab)));
}
function switchAnalysisTab(name) {
  document.querySelectorAll('.analysis-tab').forEach(t => t.classList.toggle('active', t.dataset.atab === name));
  document.querySelectorAll('.analysis-pane').forEach(p => p.classList.toggle('active', p.id === 'atab-' + name));
}
function initAnalysisResize() {
  const handle = el('analysis-resize'), panel = el('analysis-panel');
  if (!handle || !panel) return;
  let active = false, startY = 0, startH = 0;
  handle.addEventListener('mousedown', e => { active = true; startY = e.clientY; startH = panel.offsetHeight; document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; });
  document.addEventListener('mousemove', e => { if (!active) return; const newH = Math.max(120, Math.min(520, startH + (startY - e.clientY))); panel.style.height = newH + 'px'; });
  document.addEventListener('mouseup', () => { active = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; });
}

function bindButtons() {
  el('btn-deobfuscate')?.addEventListener('click', () => runPipeline({ beautifyOnly: false }));
  el('btn-beautify')?.addEventListener('click',    () => runPipeline({ beautifyOnly: true }));
  el('btn-clear')?.addEventListener('click',       clearAll);
  el('btn-copy')?.addEventListener('click',        handleCopy);
  el('btn-download')?.addEventListener('click',    handleDownload);
  el('btn-theme')?.addEventListener('click',       toggleTheme);
  el('btn-console-clear')?.addEventListener('click', () => logger.clear());
  el('btn-batch-toggle')?.addEventListener('click', () => { switchAnalysisTab('batch'); el('btn-batch-toggle')?.classList.add('active'); });
  el('btn-settings')?.addEventListener('click',       () => settings.toggle());
  el('btn-settings-close')?.addEventListener('click', () => settings.close());
  el('settings-overlay')?.addEventListener('click',   () => settings.close());
  el('btn-passes-reset')?.addEventListener('click',   () => settings.resetDefaults());
}

async function runPipeline({ beautifyOnly = false } = {}) {
  if (isProcessing) { bridge.abort(); return; }
  const code = editors.getInput().trim();
  if (!code) { logger.warn('No input code to process.'); return; }
  inputCode = code; isProcessing = true;
  document.body.classList.add('processing');
  progress.set(2, 'Starting pipeline…');
  const passes = settings.getPassState();
  editors.setOutput(''); setOutputMeta('Processing…'); disableOutputButtons(true);
  const startTime = performance.now();
  try {
    const result = await bridge.run({ code, options: { beautifyOnly }, passes, onProgress: ({ progress: pct, label }) => progress.set(pct, label) });
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    if (result.ok) {
      outputCode = result.output ?? '';
      editors.setOutput(outputCode);
      setOutputMeta(`${(result.stats.outputLines ?? 0).toLocaleString()} lines · ${elapsed}s`);
      disableOutputButtons(false);
      logger.success(`Done in ${elapsed}s — ${result.stats.passesRun?.length ?? 0} passes · ${(result.stats.inputLines ?? 0).toLocaleString()} → ${(result.stats.outputLines ?? 0).toLocaleString()} lines`);
      if (result.stats.passesRun?.length) { logger.showPassResults(result.stats.passesRun, result.stats.passesSkipped ?? []); tlogView?.addSession(result.stats.passesRun, result.stats.passesSkipped ?? [], result.stats.totalTime); }
      if (result.stats.ast) astViz?.render(result.stats.ast);
      diffView?.render(inputCode, outputCode);
      progress.complete();
    } else {
      handlePipelineError(result.error, elapsed);
    }
  } catch(err) {
    if (err.name === 'AbortError') { logger.warn('Processing aborted by user.'); progress.reset(); setOutputMeta('Aborted'); }
    else handlePipelineError(err.message);
  } finally { isProcessing = false; document.body.classList.remove('processing'); }
}

async function runBatch(files) {
  logger.info(`Starting batch: ${files.length} files…`);
  switchAnalysisTab('batch');
  const passes = settings.getPassState();
  const processor = new BatchProcessor(pool);
  batchPanel?.setRunning(true);
  const results = await processor.run(files, passes, {}, ({ done, total, name }) => {
    batchPanel?.updateProgress({ done, total, name });
    progress.set(Math.round((done / total) * 100), `Batch: ${done}/${total} — ${name}`);
  });
  batchPanel?.setResults(results);
  batchPanel?.setRunning(false);
  const ok = results.filter(r => r.ok).length;
  logger.success(`Batch complete: ${ok}/${results.length} succeeded`);
  progress.complete();
}

function handlePipelineError(message, elapsed) {
  logger.error(`Pipeline error${elapsed ? ` after ${elapsed}s` : ''}: ${message}`);
  progress.error('Error — see console');
  setOutputMeta('Error');
  el('input-pane')?.classList.add('has-error');
  setTimeout(() => el('input-pane')?.classList.remove('has-error'), 3000);
}

async function handleCopy() {
  if (!outputCode) return;
  const btn = el('btn-copy');
  const ok = await copyToClipboard(outputCode);
  if (ok && btn) { flashButton(btn, '<span class="btn-icon-inner">✓</span> Copied!'); logger.success('Output copied to clipboard.'); }
}

function handleDownload() {
  if (!outputCode) return;
  downloadFile(outputCode, 'deobfuscated.js');
  logger.info('Downloaded deobfuscated.js');
}

function clearAll() {
  editors.clear(); outputCode = ''; inputCode = '';
  disableOutputButtons(true); setOutputMeta('Waiting for input'); updateInputMeta(); updateInputStats('');
  progress.reset(); diffView?.clear(); tlogView?.clear(); astViz?.render(null);
  logger.info('Editors cleared.');
}

function toggleTheme() {
  isDarkTheme = !isDarkTheme;
  document.documentElement.setAttribute('data-theme', isDarkTheme ? 'dark' : 'light');
  editors.setTheme(isDarkTheme);
  const btn = el('btn-theme'); if (btn) btn.textContent = isDarkTheme ? '◐' : '◑';
}

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); runPipeline(); }
  if (mod && e.shiftKey && e.key === 'B') { e.preventDefault(); runPipeline({ beautifyOnly: true }); }
  if (mod && e.key === ',') { e.preventDefault(); settings.isOpen() ? settings.close() : settings.open(); }
  if (mod && e.key === 'l') { e.preventDefault(); switchAnalysisTab('log'); }
  if (mod && e.shiftKey && e.key === 'D') { e.preventDefault(); switchAnalysisTab('diff'); }
});

function disableOutputButtons(disabled) { ['btn-copy','btn-download'].forEach(id => { const b = el(id); if (b) b.disabled = disabled; }); }
function updateInputMeta() { const code = editors?.getInput() ?? ''; const meta = el('input-meta'); if (meta) meta.textContent = code.trim() ? `${code.split('\n').length.toLocaleString()} lines` : 'Ready'; }
function setOutputMeta(text) { const m = el('output-meta'); if (m) m.textContent = text; }
function formatBytes(b) { if (!b) return '0 B'; const u = ['B','KB','MB','GB']; const i = Math.floor(Math.log(b) / Math.log(1024)); return `${(b / Math.pow(1024, i)).toFixed(1)} ${u[i]}`; }

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
} else {
  init().catch(console.error);
}
