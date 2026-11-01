import { defineConfig, devices } from '@playwright/test';
import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: process.env.C_UI_BASE ? '.local/c-browser-output' : 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: process.env.C_UI_BASE
          ? '.local/logs/c-playwright-results.json'
          : '.local/logs/playwright-results.json',
      },
    ],
  ],
  use: {
    baseURL: `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`,
    browserName: 'chromium',
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        channel: 'chrome',
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
