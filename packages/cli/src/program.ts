import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { normalizeEol } from '@glyphdown/core'
import { Command, CommanderError } from 'commander'
import pc from 'picocolors'
import { type Api, createApi, pushWithBase } from './api.ts'
import {
  type AssetOps,
  type AssetSyncResult,
  docAssetOps,
  folderAssetOps,
  pullAssets,
  syncAssets,
} from './assets.ts'
import { type CliConfig, clearCredentials, loginWithDeviceCode, resolveConfig, writeConfig } from './config.ts'
import { SKILL_MD } from './skill-content.gen.ts'
import { parseDocRef } from './docref.ts'
import { CliError, DEGENERATE_MESSAGE } from './errors.ts'
import { clone, syncWorkspace } from './mirror.ts'
import { type SyncAction, type SyncDocResult, pullFolder, pushAll, readFolderConfig, syncExitCode } from './sync.ts'
import { findWorkspace, listMetas, recordBase, rewriteMeta, slugify, workspaceRoot, writePull } from './workspace.ts'

export { DEGENERATE_MESSAGE }

export interface ProgramDeps {
  /** Swap the API client (tests inject a fake). */
  makeApi?: (config: { serverUrl: string; apiKey?: string; sessionToken?: string }) => Api
  env?: NodeJS.ProcessEnv
  cwd?: () => string
  /** Home directory for default install-skill targets (tests inject a tmp dir). */
  home?: () => string
  /** Line sink for stdout-bound output (tests capture). */
  out?: (line: string) => void
  /** Line sink for stderr-bound diagnostics. */
  err?: (line: string) => void
  /** Fetch used outside the Api client (logout revocation); tests inject a fake. */
  fetchImpl?: typeof fetch
}

function excerpt(s: string, max = 64): string {
  const flat = s.replace(/\r?\n/g, '\\n')
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function parseIntStrict(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n)) throw new CliError(1, `not a number: ${value}`)
  return n
}

export function createProgram(deps: ProgramDeps = {}): Command {
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? (() => process.cwd())
  const home = deps.home ?? (() => homedir())
  const fetchImpl = deps.fetchImpl
  const out = deps.out ?? ((line: string) => console.log(line))
  const errOut = deps.err ?? ((line: string) => console.error(line))
  const makeApi =
    deps.makeApi ?? ((config: { serverUrl: string; apiKey?: string; sessionToken?: string }) => createApi(config))

  const config = (): CliConfig => resolveConfig(env)
  const apiFor = (serverUrl?: string): Api => {
    const c = config()
    return makeApi({
      serverUrl: serverUrl ?? c.serverUrl,
      ...(c.apiKey ? { apiKey: c.apiKey } : {}),
      ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
    })
  }

  const program = new Command()
  program
    .name('glyphdown')
    .description('Glyphdown CLI — collaborate on markdown docs (built for AI agents)')
    .exitOverride()
    .configureOutput({ writeOut: (s) => out(s.replace(/\n$/, '')), writeErr: (s) => errOut(s.replace(/\n$/, '')) })

  // -- assets helpers -----------------------------------------------------------
  // The asset scope for a workspace dir: its linked folder (folder.json)
  // when present — uploads ride the first tracked doc, every folder doc shares
  // the namespace — else the first tracked doc's own namespace (the server
  // resolves folder-vs-doc scoping per doc).
  const assetOpsFor = (dir: string): AssetOps | null => {
    const folderConfig = readFolderConfig(dir)
    const metas = listMetas(dir).sort((a, b) => a.file.localeCompare(b.file))
    if (folderConfig) {
      return folderAssetOps(apiFor(folderConfig.serverUrl), folderConfig.folderId, metas[0]?.docId ?? null)
    }
    const meta = metas[0]
    if (meta) return docAssetOps(apiFor(meta.serverUrl), meta.docId)
    return null
  }

  const printAssetResults = (results: AssetSyncResult[]): void => {
    for (const r of results) {
      const suffix = r.message ? ` — ${r.message}` : ''
      if (r.action === 'failed') errOut(pc.red(`asset ${r.filename} failed${suffix}`))
      else if (r.action === 'conflict-local-kept') out(`asset ${r.filename} ${pc.yellow('conflict-local-kept')}${suffix}`)
      else if (r.action === 'up-to-date') out(pc.dim(`asset ${r.filename} up to date`))
      else out(`asset ${r.filename} ${pc.green(r.action)}${suffix}`)
    }
  }

  // -- login ------------------------------------------------------------------
  program
    .command('login')
    .description('store an API key (agents) or sign in via device code (humans)')
    .option('--key <key>', 'API key minted in Settings → Agents (gd_sk_...)')
    .option('--server <url>', 'Glyphdown server URL to store alongside the credential')
    .action(async (opts: { key?: string; server?: string }) => {
      if (opts.key) {
        const path = writeConfig({ apiKey: opts.key, ...(opts.server ? { serverUrl: opts.server } : {}) }, env)
        out(`API key saved to ${path} (mode 600)`)
        return
      }
      if (opts.server) writeConfig({ serverUrl: opts.server }, env)
      await loginWithDeviceCode(opts.server ?? config().serverUrl, { out, env })
    })

  program
    .command('logout')
    .description('remove stored credentials (and revoke the session server-side when possible)')
    .action(async () => {
      const serverUrl = config().serverUrl
      const removed = clearCredentials(env)
      if (removed.sessionToken) {
        try {
          // better-auth's bearer plugin accepts the session token here.
          await (fetchImpl ?? fetch)(`${serverUrl.replace(/\/+$/, '')}/api/auth/sign-out`, {
            method: 'POST',
            headers: { authorization: `Bearer ${removed.sessionToken}` },
          })
          out('signed out — session revoked')
          return
        } catch {
          out('signed out locally (server revocation unreachable)')
          return
        }
      }
      out(removed.hadApiKey ? 'stored API key removed' : 'no stored credentials')
    })

  // -- install-skill / guide ----------------------------------------------------
  // Same shape as omegacode's install-skill: default to ALL known skills
  // directories — ~/.claude/skills (Claude Code), ~/.codex/skills (Codex),
  // ~/.agents/skills (the cross-agent convention) — narrow with
  // --claude / --codex / --agents, or point anywhere with --dir.
  program
    .command('install-skill')
    .description('install the glyphdown skill into agent skills directories (default: ~/.claude/skills, ~/.codex/skills, and ~/.agents/skills)')
    .option('--claude', 'only ~/.claude/skills (Claude Code)')
    .option('--codex', 'only ~/.codex/skills (Codex)')
    .option('--agents', 'only ~/.agents/skills')
    .option('--dir <path>', 'install into this skills directory instead (the skill lands in <dir>/glyphdown/)')
    .action((opts: { claude?: boolean; codex?: boolean; agents?: boolean; dir?: string }) => {
      const bases: string[] = []
      if (opts.dir) {
        bases.push(resolve(cwd(), opts.dir))
      } else {
        const all = !opts.claude && !opts.codex && !opts.agents
        if (all || opts.claude) bases.push(join(home(), '.claude', 'skills'))
        if (all || opts.codex) bases.push(join(home(), '.codex', 'skills'))
        if (all || opts.agents) bases.push(join(home(), '.agents', 'skills'))
      }
      for (const base of bases) {
        const target = join(base, 'glyphdown')
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'SKILL.md'), SKILL_MD)
        out(`installed skill → ${join(target, 'SKILL.md')}`)
      }
      out(pc.dim('your agent picks it up automatically — try asking it to "sync my notes"'))
    })

  program
    .command('guide')
    .description('print the agent skill/usage guide to stdout (the skill body, minus frontmatter)')
    .action(() => {
      out(SKILL_MD.replace(/^---\n[\s\S]*?\n---\n+/, ''))
    })

  // -- list -------------------------------------------------------------------
  program
    .command('list')
    .description('docs you can access')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const docs = await apiFor().listDocs()
      if (opts.json) {
        out(JSON.stringify(docs, null, 2))
        return
      }
      if (docs.length === 0) {
        out('no docs')
        return
      }
      for (const d of docs) out(`${pc.dim(d.id)}  ${d.role.padEnd(9)}  ${d.title}`)
    })

  // -- cat --------------------------------------------------------------------
  program
    .command('cat')
    .description('print a doc (working view) to stdout')
    .argument('<doc>', 'doc id or URL')
    .option('--clean', 'strip pending suggested insertions ("reject all" view)')
    .option('--json', 'machine-readable output')
    .action(async (doc: string, opts: { clean?: boolean; json?: boolean }) => {
      const docId = parseDocRef(doc)
      const view = opts.clean ? 'clean' : 'working'
      const content = await apiFor().getContent(docId, view)
      if (opts.json) {
        out(JSON.stringify({ docId, view, text: content.text, versionId: content.versionId }, null, 2))
        return
      }
      out(content.text)
    })

  // -- new --------------------------------------------------------------------
  program
    .command('new')
    .description('create a doc (the name is slugified into its filename); prints its id and URL')
    .argument('<name>', 'doc name — slugified into <slug>.md (collisions get -2, -3, …)')
    .option('--folder <folderId>')
    .option('--json', 'machine-readable output')
    .action(async (name: string, opts: { folder?: string; json?: boolean }) => {
      const requested = `${slugify(name.replace(/\.md$/i, ''))}.md`
      const meta = await apiFor().createDoc({
        filename: requested,
        ...(opts.folder ? { folderId: opts.folder } : {}),
      })
      const url = `${config().serverUrl.replace(/\/+$/, '')}/d/${meta.id}`
      if (opts.json) {
        out(JSON.stringify({ ...meta, url }, null, 2))
        return
      }
      out(meta.id)
      out(url)
      if (meta.filename !== undefined && meta.filename !== requested) {
        out(pc.dim(`created as ${meta.filename} (${requested} was taken)`))
      } else if (requested !== `${name}.md` && requested !== name) {
        out(pc.dim(`created as ${requested}`))
      }
    })

  // -- mv ---------------------------------------------------------------------
  program
    .command('mv')
    .description('rename a tracked doc: the local file AND the server filename move together')
    .argument('<file>', 'tracked markdown file (pulled/cloned here)')
    .argument('<new-name>', 'new name (slugified; the .md is optional)')
    .action(async (fileArg: string, newName: string) => {
      const ws = findWorkspace(fileArg, cwd())
      const requestedStem = newName.replace(/\.md$/i, '')
      const filename = `${slugify(requestedStem)}.md`
      if (slugify(requestedStem) !== requestedStem) {
        errOut(pc.dim(`note: ${newName} → ${filename} (doc names are slugs)`))
      }
      if (filename === ws.meta.file) {
        out(`${ws.meta.file} already has that name`)
        return
      }
      const targetPath = join(ws.dir, filename)
      if (existsSync(targetPath)) {
        throw new CliError(1, `${filename} already exists here — pick another name`)
      }
      // Server first (it owns uniqueness — 409 filename-taken aborts before
      // anything moves locally), then the local file + manifest.
      const updated = await apiFor(ws.meta.serverUrl).renameDoc(ws.meta.docId, filename)
      const canonical = updated.filename !== undefined && updated.filename !== '' ? updated.filename : filename
      try {
        renameSync(ws.path, join(ws.dir, canonical))
        rewriteMeta(ws.dir, { ...ws.meta, file: canonical })
      } catch (error) {
        throw new CliError(
          1,
          `server renamed to ${canonical}, but the local rename failed: ${error instanceof Error ? error.message : String(error)} — run \`glyphdown sync\` to converge`,
        )
      }
      out(`renamed ${ws.meta.file} → ${canonical} (local file and server filename)`)
    })

  // -- clone ------------------------------------------------------------------
  program
    .command('clone')
    .description('mirror every folder and doc you can access into a local workspace')
    .argument('[dir]', 'target directory (default: ./glyphdown)')
    .action(async (dirArg: string | undefined) => {
      const serverUrl = config().serverUrl
      const result = await clone({
        api: apiFor(),
        serverUrl,
        ...(dirArg !== undefined ? { dir: dirArg } : {}),
        cwd: cwd(),
        out,
        err: errOut,
      })
      out(`cloned ${result.folders} folder(s), ${result.docs} doc(s) → ${result.dir}`)
      out(pc.dim('workspace recorded in .glyphdown/workspace.json — run `glyphdown sync` to keep it mirrored'))
      if (result.failures > 0) throw new CliError(1, `clone: ${result.failures} item(s) failed`)
    })

  // -- pull -------------------------------------------------------------------
  program
    .command('pull')
    .description('write <slug>.md plus .glyphdown/<docId>/{meta.json,base.md}; --folder pulls a whole folder')
    .argument('[doc]', 'doc id or URL (with --folder: the target directory instead)')
    .argument('[path]', 'target file (default: <slug-of-title>.md)')
    .option('--clean', 'pull the clean view (pending suggested insertions stripped)')
    .option('--folder <folderRef>', 'pull every non-deleted doc in a folder (id or exact name)')
    .action(async (doc: string | undefined, pathArg: string | undefined, opts: { clean?: boolean; folder?: string }) => {
      const serverUrl = config().serverUrl

      if (opts.folder !== undefined) {
        if (pathArg !== undefined) {
          throw new CliError(1, 'with --folder pass at most one positional argument (the target directory)')
        }
        if (opts.clean) throw new CliError(1, '--clean cannot be combined with --folder')
        const api = apiFor()
        const result = await pullFolder({
          api,
          serverUrl,
          folderRef: opts.folder,
          ...(doc !== undefined ? { dir: doc } : {}),
          cwd: cwd(),
          out,
        })
        // Folder assets land next to the docs; failures warn, never block the
        // pull (the docs are already on disk).
        const assetResults = await pullAssets({
          dir: result.dir,
          ops: folderAssetOps(api, result.folder.id, null),
          err: errOut,
        })
        printAssetResults(assetResults.filter((r) => r.action !== 'up-to-date'))
        out(`folder ${pc.bold(result.folder.name)}: ${result.pulled.length} doc(s) → ${result.dir}`)
        out(pc.dim(`folder recorded in ${basename(workspaceRoot(result.dir))}/folder.json — \`glyphdown sync\` will pick up new docs`))
        return
      }

      if (doc === undefined) throw new CliError(1, 'missing doc — pass a doc id/URL, or use --folder <folder>')
      const docId = parseDocRef(doc)
      const api = apiFor()
      const meta = await api.getDoc(docId)
      const content = await api.getContent(docId, opts.clean ? 'clean' : 'working')
      const text = normalizeEol(content.text)
      // The server's canonical filename verbatim (legacy-server fallback:
      // slugified title — same rule the backfill applied).
      const targetPath = pathArg ?? (meta.filename !== undefined && meta.filename !== '' ? meta.filename : `${slugify(meta.title)}.md`)
      const ws = writePull(
        {
          targetPath,
          docId,
          serverUrl,
          text,
          ...(content.versionId !== null ? { versionId: content.versionId } : {}),
        },
        cwd(),
      )
      out(`pulled ${pc.bold(meta.title)} → ${ws.path}`)
      out(pc.dim(`base ${ws.meta.baseHash.slice(0, 12)} recorded in ${basename(workspaceRoot(ws.dir))}/${docId}/`))
      if (meta.folderId === null) {
        // Folderless docs carry their own asset namespace — download it into
        // the same dir (foldered docs get assets via `glyphdown pull --folder`).
        const assetResults = await pullAssets({ dir: ws.dir, ops: docAssetOps(api, docId), err: errOut })
        printAssetResults(assetResults.filter((r) => r.action !== 'up-to-date'))
      }
    })

  // -- push -------------------------------------------------------------------
  program
    .command('push')
    .description('merge local file edits into the live doc through the CRDT')
    .argument('[path]', 'pulled markdown file (with --all: the tracked directory instead)')
    .option('--all', 'push every tracked doc in the directory whose file drifted from its base')
    .option('--suggest', 'land the push as a suggestion set instead of direct edits')
    .option('--force', 'apply even when the change rewrites most of a drifted doc')
    .option('-m, --message <note>', 'note attached to the push (shown on suggestions)')
    .action(
      async (
        pathArg: string | undefined,
        opts: { all?: boolean; suggest?: boolean; force?: boolean; message?: string },
      ) => {
        if (opts.all) {
          const dir = resolve(cwd(), pathArg ?? '.')
          // Docs first; the asset pass runs even when some docs failed so a
          // bad doc cannot strand image uploads.
          let docError: unknown = null
          try {
            await pushAll({
              dir,
              apiFor: (serverUrl) => apiFor(serverUrl),
              ...(opts.suggest ? { suggest: true } : {}),
              ...(opts.force ? { force: true } : {}),
              ...(opts.message !== undefined ? { note: opts.message } : {}),
              out,
              err: errOut,
            })
          } catch (error) {
            docError = error
          }
          const ops = assetOpsFor(dir)
          if (ops) {
            const assetResults = await syncAssets({ dir, ops, mode: 'push', err: errOut })
            printAssetResults(assetResults)
            if (docError === null && assetResults.some((r) => r.action === 'failed')) {
              throw new CliError(1, 'push --all: some assets failed')
            }
          }
          if (docError !== null) throw docError
          return
        }

        const ws = findWorkspace(pathArg, cwd())
        const newText = normalizeEol(readFileSync(ws.path, 'utf8'))
        const api = apiFor(ws.meta.serverUrl)

        const { response, resentBase } = await pushWithBase(api, {
          docId: ws.meta.docId,
          newText,
          baseHash: ws.meta.baseHash,
          baseText: ws.baseText,
          ...(opts.suggest ? { suggest: true } : {}),
          ...(opts.force ? { force: true } : {}),
          ...(opts.message !== undefined ? { note: opts.message } : {}),
        })
        if (resentBase) errOut(pc.dim('server base cache missed — re-sent base.md'))

        if (!response.ok) {
          if (response.reason === 'degenerate') {
            throw new CliError(
              3,
              `${DEGENERATE_MESSAGE} (deletes ${Math.round(response.deletedRatio * 100)}% of the base)`,
            )
          }
          if (response.reason === 'base-missing') {
            throw new CliError(1, 'server rejected the base even after re-sending it — re-pull and retry')
          }
          if (response.reason === 'rate-limited') {
            throw new CliError(
              1,
              `rate-limited — retry ${response.retryAfterSec ? `in ${response.retryAfterSec}s` : 'shortly'}`,
            )
          }
          throw new CliError(1, `push rejected: ${response.reason}`)
        }

        if (response.mode === 'suggest') {
          out(`suggestion ${pc.bold(response.suggestionId)} created (version ${response.versionId})`)
          out(pc.dim('base unchanged — re-pull after the suggestion is reviewed'))
          return
        }

        if (response.failedHunks.length > 0) {
          errOut(pc.red(`${response.failedHunks.length} hunk(s) could not be applied:`))
          for (const hunk of response.failedHunks) errOut(hunk)
          errOut(pc.dim('base unchanged — re-pull, re-apply the failed edits, and push again'))
          throw new CliError(2, `push partially applied: ${response.failedHunks.length} failed hunk(s)`)
        }

        const meta = recordBase({
          dir: ws.dir,
          file: ws.meta.file,
          docId: ws.meta.docId,
          serverUrl: ws.meta.serverUrl,
          text: newText,
          versionId: response.versionId,
        })
        out(`pushed ${ws.meta.file}: ${response.applied} change(s) applied (version ${response.versionId})`)
        out(pc.dim(`base updated → ${meta.baseHash.slice(0, 12)}`))
      },
    )

  // -- sync -------------------------------------------------------------------
  const SYNC_LABELS: Record<SyncAction, string> = {
    'up-to-date': 'up to date',
    pushed: 'pushed',
    pulled: 'pulled',
    merged: 'merged',
    new: 'new',
    'remote-gone': 'remote gone',
    'skipped-degenerate': 'skipped (degenerate)',
    failed: 'failed',
    created: 'created',
    repulled: 'local missing — re-pulled',
    'folder-created': 'folder created',
    'folder-new': 'new folder (server)',
    'folder-renamed': 'folder renamed (server)',
  }

  function syncLine(r: SyncDocResult, fileWidth: number): string {
    const label = SYNC_LABELS[r.action]
    const colored =
      r.action === 'failed'
        ? pc.red(label)
        : r.action === 'skipped-degenerate' || r.action === 'remote-gone' || r.action === 'folder-renamed' || r.action === 'repulled'
          ? pc.yellow(label)
          : r.action === 'up-to-date'
            ? pc.dim(label)
            : pc.green(label)
    const extra = [r.failedHunks ? `${r.failedHunks} failed hunk(s)` : '', r.message ?? '']
      .filter(Boolean)
      .join(' — ')
    return `${r.file.padEnd(fileWidth)}  ${colored}${extra ? `  ${extra}` : ''}`
  }

  program
    .command('sync')
    .description('two-way mirror sync: tracked docs reconcile, new local files/dirs push, new server folders/docs materialize')
    .argument('[dir]', 'workspace directory (default: cwd)')
    .option('--force', 'push even when a change rewrites most of a drifted doc')
    .option('--json', 'machine-readable results')
    .action(async (dirArg: string | undefined, opts: { force?: boolean; json?: boolean }) => {
      const dir = resolve(cwd(), dirArg ?? '.')
      const { results, assetResults, notes } = await syncWorkspace({
        dir,
        apiFor: (serverUrl) => apiFor(serverUrl),
        ...(opts.force ? { force: true } : {}),
        err: errOut,
      })
      for (const note of notes) errOut(pc.dim(note))

      if (opts.json) {
        // Stable machine shape: the doc/folder results array (pre-assets
        // consumers depend on it). Asset outcomes ride stderr/human output.
        out(JSON.stringify(results, null, 2))
      } else if (results.length === 0 && assetResults.length === 0) {
        out('nothing to sync')
      } else {
        const fileWidth = Math.max(...results.map((r) => r.file.length), 4)
        for (const r of results) out(syncLine(r, fileWidth))
        printAssetResults(assetResults)
        const counts = new Map<SyncAction, number>()
        for (const r of results) counts.set(r.action, (counts.get(r.action) ?? 0) + 1)
        out(
          [...counts.entries()].map(([action, count]) => `${count} ${SYNC_LABELS[action]}`).join(', '),
        )
      }

      let exitCode = syncExitCode(results)
      if (exitCode === 0 && assetResults.some((r) => r.action === 'failed')) exitCode = 1
      if (exitCode !== 0) throw new CliError(exitCode, `sync finished with problems (exit ${exitCode})`)
    })

  // -- comments ---------------------------------------------------------------
  program
    .command('comments')
    .description('list open comment threads with their anchor quotes')
    .argument('<doc>', 'doc id or URL')
    .option('--json', 'machine-readable output')
    .action(async (doc: string, opts: { json?: boolean }) => {
      const docId = parseDocRef(doc)
      const comments = await apiFor().listComments(docId)
      const open = comments.filter((c) => !c.resolved)
      if (opts.json) {
        out(JSON.stringify(open, null, 2))
        return
      }
      if (open.length === 0) {
        out('no open comments')
        return
      }
      for (const c of open) {
        const where = c.anchor ? `"${excerpt(c.anchor.quote.exact)}"` : pc.dim('(doc-level)')
        const orphaned = c.anchor?.status === 'orphaned' ? pc.yellow(' [orphaned]') : ''
        out(`${pc.bold(c.id)} ${pc.dim(c.authorName)} ${where}${orphaned}`)
        out(`  ${c.body}`)
        for (const r of c.replies) out(`  ↳ ${pc.dim(r.authorName)} ${r.body} ${pc.dim(`(${r.id})`)}`)
      }
    })

  // -- comment ----------------------------------------------------------------
  program
    .command('comment')
    .description('add a comment, reply to a thread, or resolve one')
    .argument('<doc>', 'doc id or URL')
    .option('--body <body>', 'comment text (markdown; @mentions as @[userId])')
    .option('--reply <threadId>', 'reply to an existing thread')
    .option('--resolve <threadId>', 'resolve a thread (with --body: reply first, then resolve)')
    .option('--line <n>', 'anchor a new comment to line N (1-based)', parseIntStrict)
    .action(
      async (doc: string, opts: { body?: string; reply?: string; resolve?: string; line?: number }) => {
        const docId = parseDocRef(doc)
        const api = apiFor()
        if (opts.reply && opts.resolve) throw new CliError(1, 'use either --reply or --resolve, not both')

        if (opts.resolve) {
          if (opts.body) {
            const reply = await api.replyToComment(docId, opts.resolve, opts.body)
            out(`replied ${reply.id}`)
          }
          await api.resolveComment(docId, opts.resolve, true)
          out(`resolved ${opts.resolve}`)
          return
        }

        if (!opts.body) throw new CliError(1, '--body is required (unless only resolving with --resolve)')

        if (opts.reply) {
          const reply = await api.replyToComment(docId, opts.reply, opts.body)
          out(`replied ${reply.id} on thread ${opts.reply}`)
          return
        }

        let range: { start: number; end: number } | undefined
        if (opts.line !== undefined) {
          const { text } = await api.getContent(docId, 'working')
          const lines = text.split('\n')
          if (opts.line < 1 || opts.line > lines.length) {
            throw new CliError(1, `line ${opts.line} out of range (doc has ${lines.length} lines)`)
          }
          let start = 0
          for (let i = 0; i < opts.line - 1; i++) start += lines[i]!.length + 1
          range = { start, end: start + lines[opts.line - 1]!.length }
        }
        const comment = await api.createComment(docId, opts.body, range)
        out(`comment ${comment.id} created${range ? ` on line ${opts.line}` : ' (doc-level)'}`)
      },
    )

  // -- suggestions ------------------------------------------------------------
  program
    .command('suggestions')
    .description('list open suggestions with their proposed changes')
    .argument('<doc>', 'doc id or URL')
    .option('--json', 'machine-readable output')
    .action(async (doc: string, opts: { json?: boolean }) => {
      const docId = parseDocRef(doc)
      const suggestions = await apiFor().listSuggestions(docId)
      const open = suggestions.filter((s) => s.status === 'open')
      if (opts.json) {
        out(JSON.stringify(open, null, 2))
        return
      }
      if (open.length === 0) {
        out('no open suggestions')
        return
      }
      for (const s of open) {
        out(`${pc.bold(s.id)} ${pc.dim(s.authorName)}${s.note ? ` — ${s.note}` : ''}`)
        for (const p of s.parts) {
          const quote = excerpt(p.anchor.quote.exact)
          out(p.kind === 'insert' ? pc.green(`  + "${quote}"`) : pc.red(`  - "${quote}"`))
        }
      }
    })

  // -- snapshot ---------------------------------------------------------------
  program
    .command('snapshot')
    .description('create a named version of the doc')
    .argument('<doc>', 'doc id or URL')
    .requiredOption('-m, --message <msg>', 'version name')
    .action(async (doc: string, opts: { message: string }) => {
      const docId = parseDocRef(doc)
      const version = await apiFor().createVersion(docId, opts.message)
      out(`version ${pc.bold(version.id)} created: ${opts.message}`)
    })

  return program
}

/** Entry used by bin.ts: run argv, map errors to exit codes, never throw. */
export async function runCli(argv: string[], deps: ProgramDeps = {}): Promise<number> {
  const errOut = deps.err ?? ((line: string) => console.error(line))
  try {
    await createProgram(deps).parseAsync(argv)
    return 0
  } catch (error) {
    if (error instanceof CliError) {
      errOut(pc.red(error.message))
      return error.exitCode
    }
    if (error instanceof CommanderError) {
      // --help/--version exit cleanly; usage errors are code 1
      return error.exitCode === 0 ? 0 : 1
    }
    errOut(pc.red(error instanceof Error ? error.message : String(error)))
    return 1
  }
}
