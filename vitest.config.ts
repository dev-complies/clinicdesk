import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
