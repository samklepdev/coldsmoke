import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    // Locally, reuse whatever server is already up. In CI always start a
    // fresh one: `next build` and `next dev` share the .next directory, and a
    // dev server left running across a build can serve pages that render
    // correctly while Server Action POSTs silently no-op, which shows up as a
    // baffling assertion failure rather than an error.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
