import { defineConfig } from '@playwright/test'

const PORT = 4173

// End-to-end tests run against the production build served by the Node
// server, the same single-process setup that gets deployed.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    viewport: { width: 900, height: 600 },
  },
  webServer: {
    command: 'npm run build && npm run start',
    url: `http://127.0.0.1:${PORT}/health`,
    // A throwaway database, so test pads never land in the dev database.
    env: { PORT: String(PORT), HOST: '127.0.0.1', SQLITE_PATH: ':memory:', AI_PROVIDER: 'mock' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
