import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export default defineConfig({
  root: projectRoot,
  resolve: { alias: { "@": fileURLToPath(new URL("../../../../src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 900_000,
    setupFiles: [fileURLToPath(new URL("../../../../src/features/novel/__tests__/setup.ts", import.meta.url))],
    include: ["**/novel-prose-deep-audit/tmp/smoke-handeng.test.ts"],
  },
});
