/**
 * 闭环 CLI 实现入口（由 run-closed-loop.mjs 通过 Vite SSR loader 调用）。
 *
 * 职责：
 * 1. 在 Node.js 中 polyfill IndexedDB（fake-indexeddb）+ localStorage（供 zustand persist 读取 LLM 配置）
 * 2. 解析 CLI 参数
 * 3. 从完整 fixture seed 进程内正式库（--seed <path>）
 * 4. 调用 runClosedLoop
 * 5. 把结果（candidate + receipt + hashes）写入 .novel-bench/<timestamp>/
 * 6. 打印摘要（或 --json 输出完整 JSON）
 *
 * 不在测试覆盖范围内——测试直接调用 runClosedLoop。本文件是 CLI glue。
 */
import "fake-indexeddb/auto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

import { novelDb } from "../../src/features/novel/db";
import { runClosedLoop } from "../../src/features/novel/evaluation/closed-loop";
import {
  replaceCanonicalDatabaseFromFixture,
  verifyClosedLoopFixture,
  type ClosedLoopFixtureBundle,
} from "../../src/features/novel/evaluation/evaluation-fixture";
import { useUIStore } from "../../src/stores/ui";

interface ParsedArgs {
  projectId: string;
  chapterId: string;
  threadId: string;
  briefId: string;
  instruction?: string;
  dryRun: boolean;
  json: boolean;
  authorId: string;
  codeRevision: string;
  experimentId?: string;
  seedFixture?: string;
  apiKey?: string;
  apiBaseUrl?: string;
  chatModel?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    projectId: "",
    chapterId: "",
    threadId: "",
    briefId: "",
    dryRun: false,
    json: false,
    authorId: "closed-loop-cli",
    codeRevision: "unknown",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case "--project": result.projectId = next ?? ""; i += 1; break;
      case "--chapter": result.chapterId = next ?? ""; i += 1; break;
      case "--thread": result.threadId = next ?? ""; i += 1; break;
      case "--brief": result.briefId = next ?? ""; i += 1; break;
      case "--instruction": result.instruction = next; i += 1; break;
      case "--dry-run": result.dryRun = true; break;
      case "--json": result.json = true; break;
      case "--author": result.authorId = next ?? "closed-loop-cli"; i += 1; break;
      case "--code-rev": result.codeRevision = next ?? "unknown"; i += 1; break;
      case "--experiment": result.experimentId = next; i += 1; break;
      case "--seed": result.seedFixture = next; i += 1; break;
      case "--api-key": result.apiKey = next; i += 1; break;
      case "--base-url": result.apiBaseUrl = next; i += 1; break;
      case "--chat-model": result.chatModel = next; i += 1; break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`未知参数：${arg}（使用 --help 查看用法）`);
        process.exit(2);
    }
  }

  const missing: string[] = [];
  if (!result.projectId) missing.push("--project");
  if (!result.chapterId) missing.push("--chapter");
  if (!result.threadId) missing.push("--thread");
  if (!result.briefId) missing.push("--brief");
  if (missing.length > 0) {
    console.error(`缺少必填参数：${missing.join(", ")}`);
    console.error("使用 --help 查看完整用法");
    process.exit(2);
  }

  return result;
}

function printHelp(): void {
  console.log(`
小说创作闭环评估 CLI

用法：
  npm run novel:closed-loop -- --project <pid> --chapter <cid> --thread <tid> --brief <bid> [options]

必填参数：
  --project <id>     目标项目 ID
  --chapter <id>     目标章节 document ID
  --thread <id>      章节协作对话 thread ID
  --brief <id>       章节创作 brief ID

可选参数：
  --instruction <s>  工作流指令（默认使用 brief.goal）
  --dry-run          仅 inspect 不 promote；正式库 hash 不变
  --json             输出 CandidateBundle + receipt 为 JSON
  --author <id>      作者 ID（默认 closed-loop-cli）
  --code-rev <s>     代码版本号（默认 unknown）
  --experiment <id>  实验 ID（默认自动生成）
  --seed <path>      完整闭环 fixture JSON（由"导出评测快照"生成，必填）
  --api-key <key>    LLM API Key（默认读 process.env.OPENAI_API_KEY 或 VITE_DEFAULT_API_KEY）
  --base-url <url>   LLM Base URL（默认读 process.env.OPENAI_BASE_URL ）
  --chat-model <id>  Chat 模型 ID（默认 gpt-5-5）
  --help, -h         显示本帮助

示例：
  npm run novel:closed-loop -- --project p1 --chapter c1 --thread t1 --brief b1 --seed ./fixture.json
  npm run novel:closed-loop -- --project p1 --chapter c1 --thread t1 --brief b1 --dry-run --json
  npm run novel:closed-loop -- --project p1 --chapter c1 --thread t1 --brief b1 --seed ./fixture.json --api-key sk-xxx
`.trim());
}

/**
 * 在 Node.js 中 polyfill localStorage，使 zustand persist 能读到 LLM 配置。
 *
 * 优先级：CLI flag > process.env.OPENAI_API_KEY/OPENAI_BASE_URL > import.meta.env.VITE_DEFAULT_API_KEY（Vite SSR 注入）。
 *
 * 写入的 key 为 "ymcp-ui"，与 src/stores/ui.ts 的 persist name 一致。
 * zustand persist 读取格式：{ state: {...}, version: N }
 *
 * 导出供 run-20chapters-impl.ts 共享复用。
 */
export interface LocalStoragePolyfillInput {
  apiKey?: string;
  apiBaseUrl?: string;
  chatModel?: string;
  json?: boolean;
}

export function polyfillLocalStorage(args: LocalStoragePolyfillInput): void {
  if (typeof globalThis.localStorage !== "undefined" && globalThis.localStorage) {
    // 已有 localStorage（如 jsdom 环境），不覆盖
    return;
  }

  const apiKey = args.apiKey
    ?? process.env.OPENAI_API_KEY
    ?? "";
  const apiBaseUrl = args.apiBaseUrl
    ?? process.env.OPENAI_BASE_URL
    ?? "";
  const chatModel = args.chatModel
    ?? process.env.CHAT_MODEL
    ?? "gpt-5-5";

  const persistedState = {
    state: {
      apiBaseUrl: apiBaseUrl.trim(),
      apiKey: apiKey.trim(),
      chatModel,
      modelContextWindow: 0,
      thumbSize: 256,
      greenscreenPrompt: "",
      spritesheetPrompt: "",
      imageGenAdapter: "task",
      collapsed: false,
      incomingImage: null,
    },
    version: 5,
  };

  const store: Record<string, string> = {
    "ymcp-ui": JSON.stringify(persistedState),
  };

  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem(key: string) { return key in store ? store[key] : null; },
      setItem(key: string, value: string) { store[key] = String(value); },
      removeItem(key: string) { delete store[key]; },
      clear() { for (const key of Object.keys(store)) delete store[key]; },
      key(index: number) { return Object.keys(store)[index] ?? null; },
      get length() { return Object.keys(store).length; },
    },
    configurable: true,
    writable: true,
  });

  // 关键：zustand persist 在模块加载时（polyfill 之前）已从空环境初始化 store，
  // 此时 useUIStore.getState().apiKey === ""。仅写入 localStorage 不会让 store 重新 hydrate。
  // 必须主动 setState 同步 store，否则 ai.ts 的 getEffectiveApiConfig() 仍读到空 apiKey。
  useUIStore.setState({
    apiBaseUrl: apiBaseUrl.trim(),
    apiKey: apiKey.trim(),
    chatModel,
  });

  const writeLog = args.json ? console.error : console.log;
  writeLog(`[closed-loop] localStorage polyfill：apiKey=${apiKey ? "<已注入>" : "<空>"} baseUrl=${apiBaseUrl || "<默认>"} chatModel=${chatModel}`);
}

export async function seedCanonicalFromFixture(fixturePath: string, jsonMode: boolean): Promise<void> {
  const absPath = resolve(process.cwd(), fixturePath);
  if (!existsSync(absPath)) {
    throw new Error(`fixture 文件不存在：${absPath}`);
  }
  const fixture = JSON.parse(readFileSync(absPath, "utf-8")) as unknown;
  const verification = await verifyClosedLoopFixture(fixture);
  if (!verification.valid) throw new Error(`闭环 fixture 校验失败：${verification.issues.join("；")}`);

  await novelDb.delete();
  await novelDb.open();
  await replaceCanonicalDatabaseFromFixture(fixture as ClosedLoopFixtureBundle, novelDb);
  const writeLog = jsonMode ? console.error : console.log;
  writeLog(`[closed-loop] 已从 fixture seed 正式库：${absPath}`);
}

function generateRunDir(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dir = join(process.cwd(), ".novel-bench", "runs", `closed-loop-${ts}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runClosedLoopCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (!args.seedFixture) {
    throw new Error("CLI 使用进程内 IndexedDB，必须通过 --seed <path> 提供包含 project、document、conversationThreads 与 creativeBriefs 的完整 fixture");
  }

  // Polyfill localStorage 必须在任何 LLM 调用前完成（ai.ts → getEffectiveApiConfig → useUIStore → localStorage）
  polyfillLocalStorage(args);

  await seedCanonicalFromFixture(args.seedFixture, args.json);

  const [project, chapter, thread, brief] = await Promise.all([
    novelDb.projects.get(args.projectId),
    novelDb.documents.get(args.chapterId),
    novelDb.conversationThreads.get(args.threadId),
    novelDb.creativeBriefs.get(args.briefId),
  ]);
  const missingInputs = [
    !project && `project:${args.projectId}`,
    !chapter && `chapter:${args.chapterId}`,
    !thread && `thread:${args.threadId}`,
    !brief && `brief:${args.briefId}`,
  ].filter((value): value is string => Boolean(value));
  if (missingInputs.length) throw new Error(`fixture 缺少闭环输入：${missingInputs.join(", ")}`);

  const writeLog = args.json ? console.error : console.log;
  writeLog(`[closed-loop] 启动闭环：project=${args.projectId} chapter=${args.chapterId} dryRun=${args.dryRun}`);

  const result = await runClosedLoop({
    canonicalDb: novelDb,
    projectId: args.projectId,
    chapterId: args.chapterId,
    threadId: args.threadId,
    briefId: args.briefId,
    instruction: args.instruction,
    experimentId: args.experimentId,
    codeRevision: args.codeRevision,
    authorId: args.authorId,
    dryRun: args.dryRun,
  });

  // 写入 .novel-bench/runs/closed-loop-<timestamp>/
  const runDir = generateRunDir();
  const summary = {
    experimentId: result.experimentId,
    workflowRunId: result.workflowRunId,
    projectId: args.projectId,
    chapterId: args.chapterId,
    dryRun: args.dryRun,
    candidateId: result.candidate.id,
    inspectStatus: result.check.status,
    baselineMatches: result.check.baselineMatches,
    receiptStatus: result.receipt?.status,
    receiptOperationId: result.receipt?.operationId,
    receiptError: result.receipt?.error,
    createdRevisionId: result.receipt?.createdRevisionId,
    createdFactAssertionIds: result.receipt?.createdFactAssertionIds,
    canonicalHashBefore: result.canonicalHashBefore,
    canonicalHashAfter: result.canonicalHashAfter,
    hashAdvanced: result.canonicalHashBefore !== result.canonicalHashAfter,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(runDir, "candidate.json"), JSON.stringify(result.candidate, null, 2));
  if (result.receipt) {
    writeFileSync(join(runDir, "receipt.json"), JSON.stringify(result.receipt, null, 2));
  }
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      label: "closed-loop",
      stage: "closed-loop",
      timestamp: summary.timestamp,
      projectId: args.projectId,
      chapterId: args.chapterId,
      dryRun: args.dryRun,
    }, null, 2),
  );

  if (args.json) {
    // JSON 输出模式：candidate + receipt（适合管道处理）
    const jsonOutput = {
      candidate: result.candidate,
      check: result.check,
      receipt: result.receipt,
      canonicalHashBefore: result.canonicalHashBefore,
      canonicalHashAfter: result.canonicalHashAfter,
      runDir,
    };
    process.stdout.write(JSON.stringify(jsonOutput, null, 2));
    process.stdout.write("\n");
  } else {
    // 人类可读摘要
    console.log("");
    console.log("====== 闭环执行完成 ======");
    console.log(`实验 ID：       ${result.experimentId}`);
    console.log(`工作流 ID：     ${result.workflowRunId}`);
    console.log(`候选包 ID：     ${result.candidate.id}`);
    console.log(`inspect 状态：  ${result.check.status}`);
    console.log(`基线匹配：      ${result.check.baselineMatches}`);
    if (result.receipt) {
      console.log(`receipt 状态：  ${result.receipt.status}`);
      console.log(`operationId：   ${result.receipt.operationId}`);
      if (result.receipt.createdRevisionId) {
        console.log(`新 revision：   ${result.receipt.createdRevisionId}`);
      }
      if (result.receipt.createdFactAssertionIds.length > 0) {
        console.log(`新 facts：      ${result.receipt.createdFactAssertionIds.length} 条`);
      }
      if (result.receipt.error) {
        console.log(`错误：          ${result.receipt.error}`);
      }
    } else {
      console.log("receipt：       （dry-run 跳过 promote）");
    }
    console.log(`正式库 hash 前：${result.canonicalHashBefore.slice(0, 16)}...`);
    console.log(`正式库 hash 后：${result.canonicalHashAfter.slice(0, 16)}...`);
    console.log(`hash 前进：     ${result.canonicalHashBefore !== result.canonicalHashAfter}`);
    console.log(`产物目录：      ${runDir}`);
    console.log("===========================");
  }

  // 退出码：dryRun 或 promote 成功为 0；rejected 为 1
  if (result.receipt && result.receipt.status === "rejected") {
    return 1;
  }
  return 0;
}
