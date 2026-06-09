# Glyphdown

Google Docs for markdown files — real-time multiplayer editing, comments, suggestion mode, edit history, and a CLI built for AI agents.

Hosted at <https://glyphdown.com> · source at <https://github.com/SawyerHood/glyphdown>.

The document of record is plain markdown text, collaboratively edited through a Y.Text CRDT. **Docs are files**: a doc's canonical name is its filename — a slug ending in `.md` (e.g. `the-garden.md`), unique within its folder (or your root). The web UI shows the filename stem (Obsidian-style, no extension); the CLI uses the filename verbatim, so the same doc has the same file name on every machine, and `glyphdown mv` renames a doc locally and on the server in one step. See `SPEC.md` for the full product and architecture spec.

## For AI agents

Agents (Claude Code, etc.) collaborate on docs through the CLI: clone a workspace, edit plain `.md` files, sync — edits merge through the CRDT, or land as reviewable suggestions.

- **Install the CLI**: `npm i -g glyphdown` (or one-off: `npx glyphdown --help`) — see [`packages/cli/README.md`](packages/cli/README.md).
- **Skill**: [`skills/glyphdown/SKILL.md`](skills/glyphdown/SKILL.md) — install by copying/symlinking `skills/glyphdown` into `~/.claude/skills/`, or add this repo as a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) and install the `glyphdown` plugin.
- **Full guide**: [`docs/agent-guide.md`](docs/agent-guide.md) — every command, the sync decision matrix, exit-code recovery, suggestion lifecycle, asset rules, multi-agent etiquette.

## Stack

- **Editor**: CodeMirror 6 with Obsidian-style live preview, bound to Yjs via `y-codemirror.next`
- **Web app**: TanStack Start (React)
- **Backend**: Cloudflare Workers + Durable Objects (one DO per document)
- **Auth**: GitHub + Google OAuth
- **CLI**: `glyphdown pull` / `glyphdown push` / `glyphdown sync` — edit docs (or whole folders of them) as local files, merged through the CRDT

## Deployment

Pushes to `main` deploy automatically via GitHub Actions (`.github/workflows/deploy.yml`): the CI gate (typecheck, tests, web build — `.github/workflows/ci.yml`) runs first, then the deploy job applies pending D1 migrations (`wrangler d1 migrations apply inkwell --remote` — idempotent, exits cleanly when nothing is pending) and runs `wrangler deploy`. Deploys queue rather than race or cancel mid-flight, and the workflow can also be run manually from the Actions tab (`workflow_dispatch`). The deploy job never runs on forks or pull requests.

**One-time setup** — the workflow needs a Cloudflare API token in the `CLOUDFLARE_API_TOKEN` repo secret:

1. [dash.cloudflare.com](https://dash.cloudflare.com) → My Profile → API Tokens → Create Token → start from the **Edit Cloudflare Workers** template.
2. Add the **D1 → Edit** permission and scope the token to the account that owns the `inkwell` worker (the account id is pinned in the workflow file — it is not a secret).
3. `gh secret set CLOUDFLARE_API_TOKEN` (paste the token when prompted).

**Manual fallback** (unchanged): from `apps/web`, run `pnpm db:migrate:remote` (applies D1 migrations) then `pnpm run deploy` (vite build + `wrangler deploy`) with a logged-in wrangler.
