import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 600000,
    hookTimeout: 600000,
    include: [".goal/goals/novel-story-guidance/tmp/smoke-e2e.test.ts"],
  },
});
