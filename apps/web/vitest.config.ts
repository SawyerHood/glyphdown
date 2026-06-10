import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Standalone vitest config: the app's vite.config.ts loads the cloudflare
// plugin (workerd), which the unit tests here neither need nor tolerate.
export default defineConfig({
  resolve: {
    alias: {
      // node's ESM loader rejects the cloudflare: scheme — router-level tests
      // run against this stub and inject fake bindings into its `env`.
      'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    environment: 'node',
    server: {
      deps: {
        // These import `cloudflare:workers` themselves — inline them so the
        // alias above applies instead of node's loader rejecting the scheme.
        inline: ['partyserver', 'y-partyserver'],
      },
    },
  },
})
