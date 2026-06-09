import { defineConfig } from 'vitest/config'

// Standalone vitest config: the app's vite.config.ts loads the cloudflare
// plugin (workerd), which the unit tests here neither need nor tolerate.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    environment: 'node',
  },
})
