// Publish entrypoint for the `glyphdown` npm package.
//
// WHY THIS EXISTS (the bug it fixes):
//   npm builds the *registry metadata document* (what the registry serves at
//   https://registry.npmjs.org/glyphdown and what `npm i`/`npx` read to resolve
//   deps) from package.json **as it is read at the start of `npm publish`** —
//   i.e. BEFORE the `prepack` lifecycle script runs. The tarball's own
//   package.json is rewritten by prepack, so the *tarball* looks clean ({}),
//   but the registry doc still carries the dev manifest's `workspace:*`
//   dependencies. Installers then fail with EUNSUPPORTEDPROTOCOL.
//
// THE FIX (layering — read this before touching the scripts):
//   1. build-npm.mjs   — bundles src/bin.ts -> dist/cli.js (zero runtime deps).
//                        Pure build step. No manifest swap.
//   2. publish-npm.mjs — THIS file. Swaps the real package.json on disk for the
//                        stripped publish manifest *before* spawning `npm`, so
//                        npm reads the clean manifest when it builds BOTH the
//                        registry doc and the tarball. Always restores the dev
//                        manifest afterwards (finally + signal handlers).
//   3. prepack/postpack — now build-ONLY. They no longer swap the manifest
//                        (that would be a double-swap on top of this script).
//                        prepack just rebuilds dist/cli.js + copies LICENSE;
//                        postpack just removes the LICENSE copy.
//
// USAGE:
//   node scripts/publish-npm.mjs                 # real publish (OTP prompt)
//   node scripts/publish-npm.mjs --dry-run       # no upload, prints proof
//   node scripts/publish-npm.mjs --otp=123456    # pass 2FA code through
//   node scripts/publish-npm.mjs --provenance    # OIDC/provenance (CI)
//   ...any extra args are forwarded verbatim to `npm publish`.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(pkgDir, 'package.json')
const backupPath = join(pkgDir, 'package.json.publish-bak')
const licensePath = join(pkgDir, 'LICENSE')

const passthroughArgs = process.argv.slice(2)
const isDryRun = passthroughArgs.includes('--dry-run')

/**
 * Build the stripped publish manifest from the dev manifest. Keeps publishing
 * metadata, drops everything monorepo-only (scripts, devDependencies, TS-source
 * `exports`, and crucially the `workspace:*` dependencies). The published
 * package has ZERO runtime deps because everything is bundled into dist/cli.js.
 */
function buildPublishManifest(devPkg) {
  const publishPkg = {
    name: devPkg.name,
    version: devPkg.version,
    description: devPkg.description,
    type: devPkg.type,
    license: devPkg.license, // MIT
    bin: devPkg.bin,
    // Pin to the bundle file itself: `dist` may also hold bun-compiled
    // binaries (build:bin:all) that must never reach the tarball.
    files: ['dist/cli.js', 'README.md'],
    keywords: devPkg.keywords,
    repository: devPkg.repository,
    homepage: devPkg.homepage,
    bugs: devPkg.bugs,
    engines: devPkg.engines, // node >=20
    // Everything is bundled; the published package has zero runtime deps.
    dependencies: {},
  }

  // Required-field guard: a missing field would silently ship a broken package.
  for (const key of ['name', 'version', 'bin', 'license', 'engines', 'repository', 'homepage']) {
    if (publishPkg[key] === undefined) {
      throw new Error(`publish manifest missing required field: ${key}`)
    }
  }
  // Belt-and-suspenders: this is the exact bug we are fixing. Never ship a
  // manifest that still mentions a workspace range, anywhere.
  if (JSON.stringify(publishPkg).includes('workspace:')) {
    throw new Error('workspace: range leaked into the publish manifest')
  }
  return publishPkg
}

/**
 * Safety gate: refuse to run if packages/cli has git changes that are NOT just
 * our own swap (package.json, package.json.publish-bak, LICENSE). A dirty tree
 * could mean a half-finished edit gets published, or that a previous crash left
 * the dev manifest un-restored — in which case the "dev" manifest we back up
 * here would actually be the stripped one.
 */
function assertCleanGitState() {
  // `git status --porcelain` reports paths relative to the repo root even when
  // run from a subdir, so resolve every reported path to an absolute path and
  // compare against the absolute paths we are allowed to touch.
  const res = spawnSync('git', ['status', '--porcelain', '--', '.'], {
    cwd: pkgDir,
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    // No git? Don't block publishing (e.g. publishing from an unpacked tarball).
    console.error('publish-npm: skipping git cleanliness check (git unavailable)')
    return
  }
  const repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: pkgDir,
    encoding: 'utf8',
  }).stdout.trim()
  // The publish swap itself only ever touches these three. Plus the new
  // publish-npm.mjs script, which an in-progress publish PR will have as
  // untracked/modified — it must not block its own dry-run.
  const allowed = new Set(
    ['package.json', 'package.json.publish-bak', 'LICENSE', 'scripts/publish-npm.mjs'].map((p) =>
      join(pkgDir, p),
    ),
  )
  const dirty = res.stdout
    .split('\n')
    .map((line) => line.slice(3).trim()) // strip the 2-char status + space
    .filter(Boolean)
    .map((file) => file.replace(/^"|"$/g, ''))
    .map((file) => join(repoRoot, file))
    .filter((abs) => !allowed.has(abs))
  if (dirty.length > 0) {
    throw new Error(
      `packages/cli has uncommitted changes beyond the publish swap:\n  ${dirty.join('\n  ')}\n` +
        'Commit or stash them before publishing.',
    )
  }
}

let manifestSwapped = false

/** Restore the dev manifest and clean up the LICENSE copy. Idempotent. */
function restore() {
  if (manifestSwapped && existsSync(backupPath)) {
    renameSync(backupPath, pkgPath)
    manifestSwapped = false
    console.error('publish-npm: restored dev package.json')
  }
  rmSync(licensePath, { force: true })
}

// Restore on fatal signals too (Ctrl-C during the OTP prompt is the common one),
// so an interrupted publish never leaves the stripped manifest on disk.
let restoredBySignal = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!restoredBySignal) {
      restoredBySignal = true
      restore()
    }
    process.exit(130)
  })
}

async function main() {
  assertCleanGitState()

  // 1. Fresh bundle (zero-dep dist/cli.js). build-npm.mjs is build-only.
  execFileSync(process.execPath, [join(pkgDir, 'scripts/build-npm.mjs')], { stdio: 'inherit' })

  // 2. LICENSE next to package.json (repo-root LICENSE is the source of truth;
  //    npm auto-includes a top-level LICENSE in the tarball).
  copyFileSync(join(pkgDir, '../../LICENSE'), licensePath)

  // 3. Swap the REAL package.json on disk BEFORE spawning npm. This is the
  //    whole point: npm now reads the stripped manifest when it builds the
  //    registry metadata document (deps {}), not just the tarball.
  const devPkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const publishPkg = buildPublishManifest(devPkg)
  copyFileSync(pkgPath, backupPath)
  writeFileSync(pkgPath, `${JSON.stringify(publishPkg, null, 2)}\n`)
  manifestSwapped = true

  // PROOF: print exactly what npm is about to read. The `dependencies` field
  // here is what lands in the registry document — it MUST be {}.
  console.error('\n=== publish-npm: on-disk package.json npm will read ===')
  console.error(JSON.stringify(publishPkg, null, 2))
  console.error(`=== dependencies = ${JSON.stringify(publishPkg.dependencies)} (registry metadata source) ===\n`)

  // 4. Spawn `npm publish`, forwarding extra args (--otp / --provenance /
  //    --dry-run). Inherit stdio so the interactive OTP prompt works.
  const npmArgs = ['publish', '--access', 'public', ...passthroughArgs]
  console.error(`publish-npm: running npm ${npmArgs.join(' ')}${isDryRun ? ' (dry run)' : ''}`)
  const res = spawnSync('npm', npmArgs, { cwd: pkgDir, stdio: 'inherit' })
  if (res.error) throw res.error
  if (res.status !== 0) {
    process.exitCode = res.status ?? 1
    console.error(`publish-npm: npm publish exited with code ${res.status}`)
  } else {
    console.error('publish-npm: npm publish succeeded')
  }
}

try {
  await main()
} catch (err) {
  console.error(`publish-npm: ${err.message}`)
  process.exitCode = 1
} finally {
  // ALWAYS restore the dev manifest, even on throw/early-exit.
  restore()
}
