#!/usr/bin/env node
// PRIVATE owner tooling — never published, not part of the glyphdown CLI.
// Lists the feature requests / bug reports filed through the web app's
// feedback dialog, straight from the production D1 database via wrangler
// (needs Cloudflare access to the `inkwell` database — i.e. us).
//
// Usage (from apps/web):
//   pnpm feedback                       # newest 100, human-readable
//   pnpm feedback --type bug            # only bugs (or: feature)
//   pnpm feedback --limit 20
//   pnpm feedback --json                # machine-readable
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const json = args.includes('--json')
const flag = (name) => {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : undefined
}
const type = flag('--type')
if (type !== undefined && type !== 'bug' && type !== 'feature') {
  console.error(`--type must be "bug" or "feature", got: ${type}`)
  process.exit(1)
}
const limit = Number.parseInt(flag('--limit') ?? '100', 10)
if (!Number.isInteger(limit) || limit < 1) {
  console.error(`--limit must be a positive integer`)
  process.exit(1)
}

// type/limit are validated above (enum + integer) — nothing user-shaped
// reaches the SQL string.
const sql =
  `SELECT f.type, f.body, f.page, f.created_at, f.principal_id, f.user_id, u.name, u.email ` +
  `FROM feedback f LEFT JOIN user u ON u.id = f.user_id` +
  (type ? ` WHERE f.type = '${type}'` : '') +
  ` ORDER BY f.created_at DESC LIMIT ${limit}`

const res = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'inkwell', '--remote', '--json', '--command', sql], {
  cwd: webDir,
  encoding: 'utf8',
})
if (res.status !== 0) {
  console.error(res.stderr || res.stdout || `wrangler exited with ${res.status}`)
  process.exit(res.status ?? 1)
}

let rows
try {
  rows = JSON.parse(res.stdout)[0].results
} catch {
  console.error('could not parse wrangler output:')
  console.error(res.stdout)
  process.exit(1)
}

const items = rows.map((r) => ({
  type: r.type,
  body: r.body,
  page: r.page,
  createdAt: r.created_at,
  user: { id: r.user_id, name: r.name ?? 'Unknown', email: r.email ?? null },
  filedByAgent: r.principal_id !== r.user_id,
}))

if (json) {
  console.log(JSON.stringify(items, null, 2))
  process.exit(0)
}
if (items.length === 0) {
  console.log('no feedback yet')
  process.exit(0)
}

const tty = process.stdout.isTTY
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => paint('2', s)

for (const f of items) {
  const tag = f.type === 'bug' ? paint('31', 'bug    ') : paint('34', 'feature')
  const when = new Date(f.createdAt).toISOString().slice(0, 16).replace('T', ' ')
  const who = f.user.email ?? f.user.name
  console.log(`${tag} ${dim(when)} ${who}${f.filedByAgent ? dim(' (via agent)') : ''}${f.page ? dim(` · ${f.page}`) : ''}`)
  console.log(`  ${f.body.replace(/\n/g, '\n  ')}`)
}
console.log(dim(`\n${items.length} item(s)`))
