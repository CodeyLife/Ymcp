import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import baseConfig from "./vitest.config";

// 独立 defineConfig 覆盖 test 节，仅继承 resolve.alias。
// 用于运行 e2e-*.test.ts（被 vitest.config.ts 的 exclude 规则排除）。
export default defineConfig({
  resolve: baseConfig.resolve ?? { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./src/features/novel/__tests__/setup.ts"],
    include: ["src/features/novel/__tests__/e2e-*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 1_800_000, // 30 分钟
    hookTimeout: 600_000,
  },
});
