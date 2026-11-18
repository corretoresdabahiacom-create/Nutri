import { defineConfig, devices } from '@playwright/test'

/** E2E contra o Worker real (wrangler dev) com D1 local e dados de demonstração fictícios. Firefox/WebKit rodam no CI (browsers instalados por `playwright install`). */
const PORT = 8799
const only = process.env.E2E_BROWSERS?.split(',')
const all = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  { name: 'mobile-safari', use: { ...devices['iPhone 14'] } }
]
export default defineConfig({
  testDir: './e2e', timeout: 60_000, fullyParallel: false, workers: 1, retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: only ? all.filter((p) => only.includes(p.name)) : all,
  webServer: {
    command: `rm -rf .wrangler/e2e && npx wrangler d1 migrations apply nutrivida --local --persist-to .wrangler/e2e && npx wrangler dev --port ${PORT} --persist-to .wrangler/e2e`,
    url: `http://localhost:${PORT}/api/health`, reuseExistingServer: !process.env.CI, timeout: 120_000
  }
})
