import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/functional/**/*.test.ts"],
    root: new URL("../..", import.meta.url).pathname,
    testTimeout: 30_000
  }
});
