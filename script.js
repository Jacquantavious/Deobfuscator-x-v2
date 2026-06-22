'use strict';

// worker.js handles all Babel/Prettier transforms — loaded as a real ES module Worker.

// ════════════════════════════════════════════════════════════════════════════
// BUG FIX 1 & 2: Capture currentScript NOW, at parse time, while the browser
// is still executing this <script> tag.  document.currentScript is only valid
// during synchronous script execution — after any await / DOMContentLoaded it
// becomes null.  We store it here so resolveWorkerUrl() can use it later,
// even though the function itself is called lazily (after the DOM is ready).
// This replaces the broken top-level `const WORKER_URL = resolveWorkerUrl()`
// which ran before any <script> tags were in the DOM, so querySelectorAll
// always returned an empty NodeList.
// ════════════════════════════════════════════════════════════════════════════
const _SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';

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
// WORKER URL RESOLUTION  (Fix for Bugs 1 & 2)
//
// resolveWorkerUrl() is now called lazily — only when the first Worker is
// about to be spawned, which always happens after DOMContentLoaded.
// At that point document.querySelectorAll('script[src]') will return a full
// NodeList.  We also use _SCRIPT_SRC (captured synchronously above) as a
// reliable primary source, with the querySelectorAll scan and URL-relative
// fallback as backups.
//
// The old top-level  `const WORKER_URL = resolveWorkerUrl();`  is gone.
// Instead _workerUrlCache lazily memoises the result on first call.
// ════════════════════════════════════════════════════════════════════════════

let _workerUrlCache = null;

function resolveWorkerUrl() {
  if (_workerUrlCache) return _workerUrlCache;

  // Primary: src captured synchronously from document.currentScript at parse time.
  if (_SCRIPT_SRC && _SCRIPT_SRC.includes('script.js')) {
    _workerUrlCache = _SCRIPT_SRC.replace(/script\.js([?#].*)?$/, 'worker.js');
    return _workerUrlCache;
  }

  // Secondary: scan live DOM (safe here because we are always called after DOMContentLoaded).
  const scripts = document.querySelectorAll('script[src]');
  for (const s of scripts) {
    if (s.src && s.src.includes('script.js')) {
      _workerUrlCache = s.src.replace(/script\.js([?#].*)?$/, 'worker.js');
      return _workerUrlCache;
    }
  }

  // Fallback: derive from location — handles any GitHub Pages subpath.
  _workerUrlCache = new URL('worker.js', location.href).href;
  return _workerUrlCache;
}

// ════════════════════════════════════════════════════════════════════════════
// WORKER BRIDGE
// ════════════════════════════════════════════════════════════════════════════

class WorkerBridge {
  constructor() { this._worker = null; this._onProgress = null; this._resolvers = null; }
  _getWorker() {
    if (!this._worker) {
      // resolveWorkerUrl() is called here — safely after DOM is ready.
      this._worker = new Worker(resolveWorkerUrl(), { type: 'module' });
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
    // resolveWorkerUrl() is called here — safely after DOM is ready.
    return new Worker(resolveWorkerUrl(), { type: 'module' });
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
// MONACO LOADER HELPER  (Fix for Bug 3)
//
// Monaco installs its AMD runtime by patching the global `require` that was
// pre-seeded with a paths config object.  The patch is synchronous but the
// <script src="loader.js"> tag may not have finished executing by the time
// our DOMContentLoaded handler runs — especially on slow CDN connections or
// when the browser queues script evaluation.
//
// monacoRequire() — returns the AMD require installed by loader.js.
//
// Because loader.js and script.js are both plain (non-async, non-defer)
// <script> tags in index.html, the browser guarantees they execute in
// document order.  By the time script.js runs a single line, loader.js has
// already finished and replaced the plain config-object stub with its AMD
// callable.  No polling or waiting is needed.
//
// We keep a tiny guard: if for any reason `require` is not yet a function
// (e.g. someone adds async/defer to the loader tag later), we throw a clear
// error rather than calling a non-function.
// ════════════════════════════════════════════════════════════════════════════

function monacoRequire(deps, callback) {
  if (typeof require !== 'function') {
    throw new Error(
      'Monaco loader.js has not run yet — make sure the loader <script> tag ' +
      'appears before script.js and has no async/defer attribute.'
    );
  }
  require(deps, callback);
}

// ════════════════════════════════════════════════════════════════════════════
// MONACO EDITOR MANAGER
// ════════════════════════════════════════════════════════════════════════════

class EditorManager {
  constructor() { this.inputEditor = null; this.outputEditor = null; this._monaco = null; this._resizeObs = null; this._isDragging = false; }

  async init({ inputEl, outputEl }) {
    return new Promise((resolve, reject) => {
      try {
        monacoRequire(['vs/editor/editor.main'], (monaco) => {
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
          } catch (err) { reject(err); }
        });
      } catch (err) { reject(err); }
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
