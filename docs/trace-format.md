# Runtime trace format (`codeviz-trace` v1)

Written by `codeviz trace browser | import-cpuprofile | collect`; read by `codeviz serve --trace` and
`codeviz export --trace` (see "Runtime traces in the UI" in `docs/design.md`). TypeScript types:
`packages/cli/src/trace/format.ts` (`TraceHeader`, `TraceTick`, `readTrace`, `parseTrace`).

JSON lines, gzip-compressed when the file name ends in `.gz`.

Line 1, header:

```json
{"format":"codeviz-trace","version":1,"repoId":"<root commit>","sha":"<HEAD>","startedAt":"2026-10-09T16:14:10.595Z","tickMs":500,"source":"browser"}
```

- `source`: `browser` (CDP precise coverage + sampling profiler), `server` (Bun preload `harness/bun-trace.ts`), `cpuprofile` (imported `.cpuprofile`).
- `sha`: `git rev-parse HEAD` in `--root` (default cwd), or `--sha` / `CODEVIZ_TRACE_SHA`. `repoId` matches the snapshot's `repoId` and is omitted when unknown.

Every following line is one tick:

```json
{"t":1002,"files":[["src/pages/makers.tsx",5]],"edges":[["src/pages/makers.tsx","src/hooks/useData.ts",12]],"functions":[["src/pages/makers.tsx","renderMakers",5]],"dropped":3}
```

- `t`: ms since `startedAt`. Ticks are deltas, not cumulative. `server` traces skip empty ticks; the others write every tick.
- `files`: `[path, n]`. Paths are repo-relative with forward slashes and limited to files `git ls-files` lists in the root, so they match the snapshot's `files[].path` for the same SHA.
- `edges`: `[from, to, n]`, meaning `from` called into `to`, and only between two different repo files.
- `functions` (optional): `[path, name, n]`. Names come from the runtime, so bundlers may rename them (for example `useSettings2`).
- `dropped` (optional): calls or samples attributed to code outside the repo (node_modules, bundler runtime, data:/eval scripts). The CLI also prints the top dropped sources when it finishes.

What `n` means for each source:

| source | `files` | `edges` |
|---|---|---|
| browser | function invocations (precise coverage call counts) | profiler samples where the two frames are adjacent on the stack |
| server | instrumented-function calls + 1 per module load | sampled caller→callee calls (1 in N, multiplied by N) |
| cpuprofile | samples with the file anywhere on the stack | samples where the two frames are adjacent on the stack |

## Capture limits

- **Server preload.** It runs `Bun.Transpiler`, then parses the result with acorn and adds one counter call as the first statement of each function body. It does not rename or wrap any binding.
  - Function identity, `const` and properties stored on functions are unchanged. `fn.toString()` does show the added call.
  - If Bun cannot transpile a file or acorn cannot parse it, that file loads without instrumentation and one line goes to stderr. Calls in that file are not counted.
  - In TSX files, `Bun.Transpiler` emits the automatic-runtime JSX helper calls but not their imports, so the preload adds the imports itself from `compilerOptions.jsxImportSource` (default `react`). If those helpers would need both the dev and the prod runtime, the file is left untouched.
  - Stack line numbers inside instrumented files refer to the transpiled code, not the original TS.
  - JavaScriptCore drops the caller frame of tail calls (`return f(x)`), so those edges are missed.
- **Network requests.** `trace browser` only fetches scripts, `SourceMap` headers and `.map` files from the traced page's origin and from `--allow-origin <origin>` (repeatable). When the page origin is unknown (attached to `about:blank` with no `<url>`), it uses loopback hosts instead. `import-cpuprofile` only fetches from loopback hosts. Code from any other origin is counted under `dropped` and never requested.
