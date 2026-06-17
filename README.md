# Deobfuscator-X v3

A fully in-browser, zero-install JavaScript deobfuscation engine with 18 AST transformation passes, Monaco Editor, and a batch processing pipeline.

**[→ Live Demo](https://your-username.github.io/deobfuscator-x-v3/)**

---

## Features

- **18 transform passes** — string array recovery, XOR decoding, control flow reconstruction, dead code removal, anti-debugger stripping, and more
- **Monaco Editor** — full VS Code editor experience for both input and output panes
- **Batch processing** — drop a `.zip` of JS files and process them all in parallel via a Web Worker pool
- **Diff viewer** — side-by-side line diff of original vs. deobfuscated output
- **AST visualizer** — interactive tree explorer of the post-transform AST
- **Transform log** — per-pass timing and message history across pipeline runs
- **Export** — copy output to clipboard, download as `.js`, or batch-export as `.zip`
- **Zero build step** — runs directly from GitHub Pages, no npm/webpack/node required

---

## Passes

| Priority | ID | Name |
|---|---|---|
| 3 | `runtimePatterns` | Runtime Pattern Detection — inline `eval(string)`, `new Function()`, `setTimeout(string)` |
| 5 | `zeroXDecoder` | _0x Decoder Recovery — resolve `_0x` string arrays and decoder functions |
| 6 | `stringArrayCleanup` | Massive String Array Cleanup — inline large encoded string pools |
| 7 | `stringDecoder` | String Decoder Reconstruction — `fromCharCode`, nibble, shift decoders |
| 8 | `xorDecoding` | XOR Decoding — byte-array XOR, split-map-join XOR, repeating-key XOR |
| 9 | `homoglyphCleanup` | Homoglyph & Unicode Identifier Cleanup — normalize lookalike characters |
| 10 | `unicodeNormalization` | Unicode Normalization — decode `\uXXXX` escape sequences |
| 12 | `hexDeobfuscation` | Hex Deobfuscation — `0xFF` → decimal, octal, binary normalization |
| 13 | `templateLiteral` | Template Literal Collapse — fold static template literals and `'a'+'b'` |
| 15 | `bitwiseSimplify` | Bitwise / Rotation Simplification — fold constant `&`, `\|`, `^`, `<<`, `>>` |
| 16 | `numericLiterals` | Numeric Literal Normalization — constant folding of arithmetic expressions |
| 17 | `propertyAccessNorm` | Property Access Normalization — `obj['key']` → `obj.key` |
| 22 | `controlFlow` | Control Flow Reconstruction — unpack `while(true)+switch` dispatcher loops |
| 25 | `rotateSimplifcation` | Rotate Simplification — remove push/shift array rotation IIFE boilerplate |
| 28 | `commaSplitter` | Comma Sequence Splitter — split `(a(), b(), c())` into discrete statements |
| 32 | `ternaryUnfold` | Ternary Unfold — convert deeply-nested ternaries to `if/else` chains |
| 45 | `deadCode` | Dead Code Removal — eliminate `if(false)`, unreachable branches, junk expressions |
| 60 | `astSimplification` | AST Simplification — constant folding, opaque predicate removal |
| 80 | `antiDebugger` | Anti-Debugger Removal — remove `debugger` statements and basic traps |
| 81 | `antiDebuggerEnhanced` | Anti-Debugger Enhanced — console-disabling, timing traps, devtools detection |
| 90 | `scopeRename` *(off by default)* | Scope-Aware Variable Rename — rename `_0x` identifiers to `_v0`/`_fn0` |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Run deobfuscation |
| `Ctrl+Shift+B` | Beautify only (no transforms) |
| `Ctrl+,` | Open/close settings |
| `Ctrl+L` | Switch to Log tab |
| `Ctrl+Shift+D` | Switch to Diff tab |
| `Escape` | Close settings panel |

---

## Deployment

This project deploys automatically to GitHub Pages on every push to `main` via the included GitHub Actions workflow.

### Manual setup

1. Fork or clone this repository
2. Go to **Settings → Pages**
3. Set source to **GitHub Actions**
4. Push to `main` — the workflow handles the rest

The live URL will be:
```
https://<your-username>.github.io/<repository-name>/
```

### Local development

No build step needed. Just serve the files with any static file server:

```bash
# Python
python3 -m http.server 8080

# Node (npx)
npx serve .

# VS Code
# Install "Live Server" extension, right-click index.html → Open with Live Server
```

Then open `http://localhost:8080`.

---

## Architecture

```
index.html          — Shell, Monaco CDN loader, settings toggles
style.css           — All styles (dark/light theme via CSS variables)
script.js           — Everything else, fully inlined:
  ├── WORKER_SOURCE     — Blob Worker string (Babel + Prettier from esm.sh)
  ├── ZipExporter       — Pure-JS ZIP builder for batch export
  ├── parseZipForJS     — Pure-JS ZIP reader for batch import
  ├── WorkerBridge      — Single-file deobfuscation via Blob Worker
  ├── WorkerPool        — Multi-worker pool for batch processing
  ├── ProgressManager   — Progress bar + pass counter
  ├── ConsoleLogger     — Analysis panel log tab
  ├── SettingsPanel     — Settings drawer with per-pass toggles
  ├── DiffViewer        — LCS-based line diff renderer
  ├── TransformLog      — Per-session pass timing history
  ├── ASTVisualizer     — Collapsible AST tree explorer
  ├── BatchPanel        — Batch UI with file list and results
  ├── DropZone          — Drag-and-drop file handler
  ├── BatchProcessor    — Parallel batch runner using WorkerPool
  └── EditorManager     — Monaco editor init, themes, resize handle
```

**CDN dependencies (loaded at runtime, no bundling):**

| Library | Used in | CDN |
|---|---|---|
| Monaco Editor 0.45 | Main thread | jsDelivr |
| @babel/parser 7.23 | Worker | esm.sh |
| @babel/traverse 7.23 | Worker | esm.sh |
| @babel/generator 7.23 | Worker | esm.sh |
| @babel/types 7.23 | Worker | esm.sh |
| Prettier 3.1 | Worker | esm.sh |

---

## License

MIT
