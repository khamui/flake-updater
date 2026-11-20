import { defineConfig } from "vitest/config";

// The injection suite evaluates real NixOS configs: run on its own, never in `npm test`.
export default defineConfig({
  test: { include: ["test/injection/**/*.test.ts"], fileParallelism: false, testTimeout: 900_000, hookTimeout: 900_000 },
});
