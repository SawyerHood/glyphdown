# AGENTS.md

This repository ships **Glyphdown** — Google Docs for markdown files (real-time multiplayer editing, comments, suggestions, history) plus the `glyphdown` CLI built for AI agents. Use this file when making code changes here.

Two different jobs, two different docs:

- **Developing Glyphdown** (this repo's code): this file + `SPEC.md`.
- **Using Glyphdown as an agent** (collaborating on docs via the CLI): [`docs/agent-guide.md`](docs/agent-guide.md), with the loadable skill in [`skills/glyphdown/SKILL.md`](skills/glyphdown/SKILL.md).

## Layout

- `apps/web` — TanStack Start web app on Cloudflare Workers + Durable Objects (one DO per doc), D1, R2.
- `packages/cli` — the `glyphdown` CLI (`src/program.ts` defines every command).
- `packages/core` — CRDT merge (`mergePush`), suggestions, anchors.
- `packages/protocol` — shared types + the HTTP surface contract.
- `packages/editor`, `packages/sync` — CodeMirror editor and Yjs sync glue.

## Tooling

- `pnpm` workspace; TypeScript everywhere. Run the CLI from source with `tsx` (`pnpm --filter @glyphdown/cli dev -- <command>`) — Node type-stripping cannot run it.
- Web dev server: `pnpm --filter web dev` (Vite + workerd; local D1 via `pnpm --filter web db:migrate:local`).

## Validation

Run before finishing changes:

```sh
pnpm -r typecheck
pnpm -r test
pnpm --filter web build
```

CLI behavior is spec'd in `SPEC.md` §8; exit codes (0/1/2/3) and the push merge algorithm are load-bearing — keep `packages/cli/README.md` and `docs/agent-guide.md` in sync with any CLI change.
