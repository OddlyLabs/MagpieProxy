import { defineConfig } from "@playwright/test"
import { existsSync } from "node:fs"
const executablePath = process.env.BROWSER_EXECUTABLE || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined)
const browserName = process.env.BROWSER === "webkit" ? "webkit" : "chromium"
export default defineConfig({
  testDir: "./test/browser", timeout: 30_000, fullyParallel: true, workers: 2,
  reporter: [["list"]],
  use: { browserName, baseURL: "http://127.0.0.1:4177", viewport: { width: 1280, height: 900 }, colorScheme: "light", launchOptions: { ...(browserName === "chromium" && executablePath ? { executablePath } : {}) }, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node scripts/preview.mjs", url: "http://127.0.0.1:4177", reuseExistingServer: !process.env.CI, timeout: 15_000 },
})
