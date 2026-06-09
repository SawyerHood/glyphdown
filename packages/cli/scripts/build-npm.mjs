// Publish build: bundle src/bin.ts into a single-file ESM CLI for plain Node
// (>=20). Everything is bundled in — workspace packages (@glyphdown/core,
// @glyphdown/protocol) are private and never published, and third-party deps
// (commander, picocolors, yjs, @sanity/diff-match-patch) ride along so the
// published package has zero runtime dependencies. No source maps, no
// minification (debuggability over bytes).
//
// The dev flows are untouched: `tsx src/bin.ts`, vitest, and the
// `bun build --compile` binary builds keep running from source.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

// The entry's own `#!/usr/bin/env node` hashbang is preserved by esbuild at
// the very top of the output (above the banner), so the banner carries only
// the provenance comment and a CommonJS `require` shim: bundled CJS deps
// (e.g. picocolors) require node builtins, and esbuild's ESM output routes
// those through `__require`, which needs a real `require` in scope.
const banner = `// glyphdown v${pkg.version} — https://github.com/SawyerHood/glyphdown (https://glyphdown.com)
// Single-file bundle (MIT). Built ${new Date().toISOString()}.
import { createRequire as __glyphdownCreateRequire } from 'node:module'
const require = __glyphdownCreateRequire(import.meta.url)`

await build({
  entryPoints: [join(pkgDir, 'src/bin.ts')],
  outfile: join(pkgDir, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  banner: { js: banner },
  logLevel: 'info',
})
