import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["dotenv/config"],
    // Integration test files share one Postgres database and each TRUNCATEs
    // it in beforeEach. Run files one at a time so those truncations cannot
    // race and tear out another file's fixtures mid-test. The suite is small
    // and runs in under a second, so the lost parallelism costs nothing.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
