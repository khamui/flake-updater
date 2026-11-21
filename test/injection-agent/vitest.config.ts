import { defineConfig } from "vitest/config";

// Real agent sessions on a fixture: run on its own, never in `npm test`.
export default defineConfig({
  test: { include: ["test/injection-agent/**/*.test.ts"], fileParallelism: false, testTimeout: 3_600_000, hookTimeout: 900_000 },
});
