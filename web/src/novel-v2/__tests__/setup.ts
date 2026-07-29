/**
 * V2 测试全局 setup。
 *
 * V2 运行时基于 Postgres + Temporal，测试用 mock pool / in-memory fakes，
 * 不需要 IndexedDB polyfill（区别于 v1 客户端 IndexedDB 测试）。
 *
 * 保留 localStorage + crypto.subtle polyfill：部分被测代码（如 model-config-store）
 * 可能间接依赖 web API，node 环境下需要补齐。
 */
import { webcrypto } from "node:crypto";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  },
  configurable: true,
});

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
