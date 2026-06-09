import { defineConfig, type Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

/**
 * better-auth 1.6.14's bundled @better-auth/kysely-adapter imports
 * DEFAULT_MIGRATION_TABLE / DEFAULT_MIGRATION_LOCK_TABLE from the "kysely"
 * root, but kysely 0.29 moved those to "kysely/migration" — rolldown fails
 * the build on the missing exports. The adapter is statically reachable from
 * better-auth core even though we use the drizzle adapter at runtime, so
 * rewrite the import. Drop this once better-auth ships a kysely-0.29 fix.
 */
function kyselyMigrationExportsFix(): Plugin {
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["']kysely["'];/
  return {
    name: 'kysely-migration-exports-fix',
    transform(code, id) {
      if (!id.includes('kysely-adapter')) return null
      const match = code.match(importRe)
      if (!match) return null
      const names = match[1]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const migration = names.filter((n) => n.startsWith('DEFAULT_MIGRATION'))
      if (migration.length === 0) return null
      const rest = names.filter((n) => !n.startsWith('DEFAULT_MIGRATION'))
      const replacement =
        (rest.length > 0 ? `import { ${rest.join(', ')} } from "kysely";\n` : '') +
        `import { ${migration.join(', ')} } from "kysely/migration";`
      return { code: code.replace(importRe, replacement), map: null }
    },
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  environments: {
    // Dev-time: the SSR dependency optimizer bundles better-auth without
    // running plugin transforms, so it would hit the kysely-0.29 missing
    // exports. Excluding it routes the package through the regular module
    // pipeline where kyselyMigrationExportsFix applies.
    ssr: {
      optimizeDeps: {
        // yjs: keep it out of the optimizer so the workerd runtime loads
        // exactly one copy (the optimizer's pre-bundled chunk plus the
        // workspace packages' direct import otherwise trip the "Yjs was
        // already imported" duplicate-instance hazard in dev). y-partyserver
        // must stay optimized — its CJS dep (lodash.debounce) cannot load
        // unbundled in workerd.
        exclude: [
          'better-auth',
          'better-auth/adapters/drizzle',
          'better-auth/tanstack-start',
          'yjs',
        ],
      },
    },
  },
  plugins: [
    devtools(),
    kyselyMigrationExportsFix(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
