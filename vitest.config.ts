import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("1.0.0"),
    __BUILD_ENV__: JSON.stringify("production"),
    __BUILD_COMMIT__: JSON.stringify("test"),
    __BUILD_TIME__: JSON.stringify("2026-11-20T10:00:00.000Z"),
    __RESOLVER_ENDPOINT__: JSON.stringify("https://resolver.example.com"),
  },
  resolve: {
    alias: {
      "@clf/matching": fromRoot("./packages/matching/src/index.ts"),
      "@clf/fixtures": fromRoot("./packages/test-fixtures/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    reporters: process.env["CI"] ? ["default"] : ["default"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/matching/src/**/*.ts", "apps/api/src/**/*.ts", "apps/extension/src/**/*.ts"],
      exclude: ["**/*.d.ts", "apps/extension/src/ui/**/*.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 65,
      },
    },
  },
});
