import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "test"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/server.ts", "src/convert.ts"],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage"
    }
  }
});
