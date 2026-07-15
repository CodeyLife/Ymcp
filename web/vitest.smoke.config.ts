import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vite.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [".goal/goals/novel-prose-iter-2/tmp/smoke-ch3.test.ts"],
      exclude: ["**/node_modules/**"],
      testTimeout: 600000,
      hookTimeout: 600000,
    },
  }),
);
