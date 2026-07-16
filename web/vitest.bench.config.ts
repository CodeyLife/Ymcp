import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import baseConfig from "./vitest.config";

// 不使用 mergeConfig——它会拼接 include/exclude 数组，导致 baseConfig 的
// `**/bench/*.test.ts` 排除规则仍生效。这里用独立 defineConfig 覆盖 test 节，
// 仅继承 resolve.alias。
export default defineConfig({
  resolve: baseConfig.resolve ?? { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./src/features/novel/__tests__/setup.ts"],
    include: ["src/features/novel/__tests__/bench/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 1_800_000, // 30 分钟（覆盖 bootstrap 20 分钟场景）
    hookTimeout: 600_000,
  },
});
