#!/usr/bin/env node
/**
 * 20 章迭代编排 CLI（novel:20chapters）
 *
 * 从基线 fixture seed 正式库 → 循环 20 章每章 createChapter + thread + brief
 * → 调用 runClosedLoop（真实 LLM） → 检查 weightedScore ≥ 3.7（最多 3 次重试）
 * → 最终 captureClosedLoopFixture 写 final-snapshot.json（可导入用户正式 DB）。
 *
 * 用法：
 *   npm run novel:20chapters -- --seed <fixture.json>
 *   npm run novel:20chapters -- --seed <fixture.json> --max-chapters 1 --dry-run
 *   npm run novel:20chapters -- --seed <fixture.json> --api-key sk-xxx
 *
 * Flags：
 *   --seed <path>          完整闭环 fixture JSON（必填，由"导出评测快照"生成）
 *   --max-chapters <n>     生成章节数（默认 20）
 *   --max-attempts <n>     每章最大重试次数（默认 3）
 *   --quality-threshold <f> 质量阈值（默认 3.7，未指定时读 project.settings.qualityThreshold）
 *   --start-chapter <n>    从第几章开始（默认 1，调试用）
 *   --end-chapter <n>      到第几章结束（默认 max-chapters，调试用）
 *   --output-dir <path>    产物目录（默认 .novel-bench/runs/lingxu-jianghu-20chapters-<ts>/）
 *   --no-resume            不读 progress.json，从 start-chapter 重新开始
 *   --dry-run              只跑 inspect 不 promote（smoke 验证用）
 *   --api-key <key>        LLM API Key（默认读 process.env.OPENAI_API_KEY）
 *   --base-url <url>       LLM Base URL（默认读 process.env.OPENAI_BASE_URL）
 *   --chat-model <id>      Chat 模型 ID（默认读 process.env.CHAT_MODEL 或 gpt-5-5）
 *   --json                 输出 JSON 摘要（默认人类可读）
 *
 * 实现说明：本脚本是 thin wrapper，实际逻辑在 run-20chapters-impl.ts 中。
 * 通过项目已安装的 Vite SSR loader 加载 TypeScript，并复用项目 alias/config。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const implPath = resolve(here, "run-20chapters-impl.ts");

// 透传所有 CLI 参数给 impl.ts
const args = process.argv.slice(2);

const server = await createServer({
  cacheDir: resolve(process.cwd(), ".novel-bench", ".vite-20chapters"),
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const module = await server.ssrLoadModule(implPath);
  const exitCode = await module.run20ChaptersCli(args);
  await server.close();
  process.exit(exitCode);
} catch (error) {
  await server.close();
  console.error("[20chapters] 执行失败：", error);
  process.exit(1);
}
