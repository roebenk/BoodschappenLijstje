import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}` },
  // Runs the exact production layout (Next standalone) with an isolated database.
  webServer: {
    command: "node .next/standalone/server.js",
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      HOSTNAME: "localhost",
      NODE_ENV: "production",
      DATA_DIR: resolve(process.env.E2E_DATA_DIR ?? resolve(process.cwd(), ".e2e-data")),
    },
  },
  projects: [
    {
      name: "iphone-15-pro",
      use: {
        channel: "msedge",
        viewport: { width: 393, height: 852 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
  ],
});
