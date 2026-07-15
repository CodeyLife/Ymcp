import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// 配置文件位于 .goal/goals/novel-deep-iteration/tmp/，需上溯 4 层到项目根
const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export default defineConfig({
  root: projectRoot,
  resolve: { alias: { "@": fileURLToPath(new URL("../../../../src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 900_000,
    setupFiles: [fileURLToPath(new URL("../../../../src/features/novel/__tests__/setup.ts", import.meta.url))],
    include: ["**/novel-deep-iteration/tmp/smoke-xianxia.test.ts"],
  },
});
