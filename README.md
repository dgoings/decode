# codeviz

Local CLI that analyzes a git repo and serves a visualization on localhost. See `docs/design.md`.

## Layout

- `packages/core` - snapshot types, merge, diff
- `packages/analyzers` - tree-sitter walker, git history, adapters
- `packages/cli` - commands, server, export (`src/cli.ts` is the entry)
- `packages/web` - UI (placeholder)

Runtime code (`core`, `analyzers`, `cli`) uses only `node:*` APIs. `Bun.*` and `bun:*` are allowed only in dev scripts.

## Commands

- `bun install` - install deps
- `bun run build` - bundle the CLI to `dist/cli.js` (Node target)
- `bun test` - run tests
- `bun run check` - fail if runtime packages use `Bun.*` / `bun:*`
- `node dist/cli.js --version`

CI runs check, test, build and a `--version` smoke test on current Bun and Node 20.
