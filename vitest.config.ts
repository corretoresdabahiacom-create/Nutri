import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, DATA_KEY: 'test-data-key-0123456789abcdef-test', PLATFORM_ADMIN_EMAIL: 'plataforma@teste.dev', RL_REGISTER: '100000', RL_LOGIN_IP: '100000' } }
      })
    ],
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'], testTimeout: 30000 }
  }
})
