import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../../../src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./src/features/novel/__tests__/setup.ts"],
    include: ["./.goal/goals/novel-story-guidance/tmp/smoke-e2e.test.ts"],
  },
});
