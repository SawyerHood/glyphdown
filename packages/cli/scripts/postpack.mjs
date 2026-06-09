// npm `postpack` hook — BUILD-ONLY cleanup.
//
// LAYERING (see scripts/publish-npm.mjs): the manifest swap + restore now lives
// in publish-npm.mjs. prepack.mjs no longer swaps package.json, so there is
// nothing here to restore — postpack only removes the LICENSE copy that
// prepack dropped next to package.json (the repo-root LICENSE is the source of
// truth and the copy must not linger in the working tree).
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')

rmSync(join(pkgDir, 'LICENSE'), { force: true })
console.error('postpack: removed LICENSE copy')
