#!/usr/bin/env node
/**
 * 小说创作闭环评估 CLI（novel:closed-loop）
 *
 * 把 capture → load → workflow → export → inspect → manuscript/fact promote 串联为单一命令。
 * Skill 与系统 Prompt 迭代由独立的跨场景规则候选流程负责。
 *
 * 用法：
 *   npm run novel:closed-loop -- --project <pid> --chapter <cid> --thread <tid> --brief <bid>
 *   npm run novel:closed-loop -- --project <pid> --chapter <cid> --thread <tid> --brief <bid> --dry-run
 *   npm run novel:closed-loop -- --project <pid> --chapter <cid> --thread <tid> --brief <bid> --json
 *
 * Flags：
 *   --project <id>     目标项目 ID（必填）
 *   --chapter <id>     目标章节 document ID（必填）
 *   --thread <id>      章节协作对话 thread ID（必填）
 *   --brief <id>       章节创作 brief ID（必填）
 *   --instruction <s>  工作流指令（可选，默认使用 brief.goal）
 *   --dry-run          仅 inspect 不 promote；正式库 hash 不变
 *   --json             输出 CandidateBundle + receipt 为 JSON（适合管道处理）
 *   --author <id>      作者 ID（默认 closed-loop-cli）
 *   --code-rev <s>     代码版本号（默认 unknown）
 *   --experiment <id>  实验 ID（默认自动生成）
 *
 * 实现说明：本脚本是 thin wrapper，实际逻辑在 run-closed-loop-impl.ts 中。
 * 通过项目已安装的 Vite SSR loader 加载 TypeScript，并复用项目 alias/config。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const implPath = resolve(here, "run-closed-loop-impl.ts");

// 透传所有 CLI 参数给 impl.ts
const args = process.argv.slice(2);

const server = await createServer({
  cacheDir: resolve(process.cwd(), ".novel-bench", ".vite-closed-loop"),
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const module = await server.ssrLoadModule(implPath);
  const exitCode = await module.runClosedLoopCli(args);
  await server.close();
  process.exit(exitCode);
} catch (error) {
  await server.close();
  console.error("[closed-loop] 执行失败：", error);
  process.exit(1);
}
