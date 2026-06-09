// npm `prepack` hook — BUILD-ONLY (no manifest swap).
//
// LAYERING (see scripts/publish-npm.mjs for the full story): the manifest swap
// that strips `workspace:*` deps now lives in publish-npm.mjs and happens
// BEFORE npm is spawned, so npm reads the clean manifest when it builds the
// registry metadata document. Doing the swap here (in prepack) was the bug:
// prepack runs too late — after npm has already snapshotted package.json for
// the registry doc — so only the tarball got the clean manifest while the
// published *metadata* still leaked the workspace ranges.
//
// This hook therefore only does the build-side prep that is safe to run on any
// `npm pack`/`npm publish`:
//   1. builds dist/cli.js (fresh zero-dep bundle)
//   2. copies the repo-root LICENSE next to package.json (npm auto-includes it)
//
// IMPORTANT: prepack runs on plain `npm pack`/`npm publish` too. To avoid a
// double-swap, do NOT swap the manifest here. Use `node scripts/publish-npm.mjs`
// (or `pnpm publish:npm`) to actually publish, never bare `npm publish`.
import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')

// 1. Fresh bundle.
execFileSync(process.execPath, [join(pkgDir, 'scripts/build-npm.mjs')], { stdio: 'inherit' })

// 2. LICENSE from the repo root (single source of truth).
copyFileSync(join(pkgDir, '../../LICENSE'), join(pkgDir, 'LICENSE'))

console.error('prepack: built dist/cli.js + copied LICENSE (manifest swap happens in publish-npm.mjs)')
