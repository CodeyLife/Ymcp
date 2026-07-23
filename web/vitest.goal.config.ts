import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import baseConfig from "./vitest.config";

// Goal-mode 专用 vitest 配置：运行 .goal/goals/<id>/tmp/*.test.ts
// 继承 baseConfig 的 resolve.alias，但用独立的 include 覆盖 test 节。
export default defineConfig({
  resolve: baseConfig.resolve ?? { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./src/features/novel/__tests__/setup.ts"],
    include: [".goal/goals/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 1_800_000, // 30 分钟（覆盖 foundation 流程 15+ 分钟场景）
    hookTimeout: 600_000,
  },
});
