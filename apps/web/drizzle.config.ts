import { defineConfig } from 'drizzle-kit'

/**
 * Migration generation only (`pnpm db:generate`). Migrations are applied with
 * wrangler (`pnpm db:migrate:local` for dev, `wrangler d1 migrations apply
 * inkwell --remote` at deploy — "inkwell" is the pinned D1 database name, not
 * the product name), so no credentials are needed here.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
