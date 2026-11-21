import { defineConfig } from "vitest/config";

// test/injection evaluates real configs and has its own config
export default defineConfig({ test: { include: ["test/unit/**/*.test.ts"] } });
