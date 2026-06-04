import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone test config. We deliberately do not load the TanStack Start / Tailwind
// plugins here -- the suite covers pure server-side logic and pulling the full app
// pipeline in just slows tests down and risks transform surprises.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Server modules read these at import time (src/server/env.ts) and construct a
    // lazy pg Pool. None of the tests touch the database, so placeholder values are
    // enough to let the modules load.
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      BETTER_AUTH_SECRET: "test-secret-value-at-least-32-chars-long",
      BETTER_AUTH_URL: "http://localhost:3000",
      GITHUB_CLIENT_ID: "test-client-id",
      GITHUB_CLIENT_SECRET: "test-client-secret",
    },
  },
});
