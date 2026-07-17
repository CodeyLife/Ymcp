import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../../../src", import.meta.url)) } },
  test: {
    environment: "node",
    setupFiles: ["./src/features/novel/__tests__/setup.ts"],
    include: [".goal/goals/novel-top-tier-iter/tmp/prose-blind-eval.test.ts"],
    testTimeout: 300_000,
  },
});
