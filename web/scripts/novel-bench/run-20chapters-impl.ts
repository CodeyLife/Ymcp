/**
 * 20 章迭代编排 CLI 实现入口（由 run-20chapters.mjs 通过 Vite SSR loader 调用）。
 *
 * 职责：
 * 1. 复用 run-closed-loop-impl.ts 的 polyfillLocalStorage + seedCanonicalFromFixture
 * 2. 解析 CLI 参数（--seed 必填，--max-chapters 默认 20，--max-attempts 默认 3，--quality-threshold 默认 3.7）
 * 3. 从基线 fixture seed 进程内正式库（novelDb）
 * 4. 读 project + architecture.phases，按章号映射到对应 phase
 * 5. for N in start..end：
 *    - 若 progress.json 已标记完成则 skip（resume 支持）
 *    - createChapter + novelMemoryService.getOrCreateThread + getDraftBrief + updateBrief + confirmBrief
 *    - for attempt in 1..maxAttempts：runClosedLoop（dryRun 由 flag 决定）
 *      - 检查 result.receipt.status==='promoted' AND result.candidate.qualityReport.weightedScore>=qualityThreshold
 *      - 满足则 break；不满足且 attempt<maxAttempts 则重试
 *    - 写 progress.json（章节N完成 + receipt + qualityScore）
 * 6. 全部完成后 captureClosedLoopFixture → final-snapshot.json
 * 7. 打印摘要（或 --json 输出完整 JSON）
 *
 * 设计依据：goal lingxu-jianghu-20chapters 的 Loop 3 计划。
 * 不在测试覆盖范围内——这是 CLI glue。测试直接调用 runClosedLoop + captureClosedLoopFixture。
 */
import "fake-indexeddb/auto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";

import { novelDb, createChapter } from "../../src/features/novel/db";
import { novelMemoryService } from "../../src/features/novel/memory-service";
import { runClosedLoop } from "../../src/features/novel/evaluation/closed-loop";
import {
  captureClosedLoopFixture,
  replaceCanonicalDatabaseFromFixture,
  verifyClosedLoopFixture,
  type ClosedLoopFixtureBundle,
} from "../../src/features/novel/evaluation/evaluation-fixture";
import type { ArchitecturePhase, StoryProject } from "../../src/features/novel/types";
import {
  polyfillLocalStorage,
  seedCanonicalFromFixture,
  type LocalStoragePolyfillInput,
} from "./run-closed-loop-impl";

// ===== CLI 参数 =====

interface ParsedArgs {
  seed: string;
  maxChapters: number;
  maxAttempts: number;
  qualityThreshold: number | undefined;
  startChapter: number;
  endChapter: number | undefined;
  outputDir?: string;
  runId?: string;
  resume: boolean;
  dryRun: boolean;
  json: boolean;
  apiKey?: string;
  apiBaseUrl?: string;
  chatModel?: string;
  /**
   * 覆盖 project.settings.textModel。
   *
   * 项目级别的 textModel 是源真值，但有时提供商某模型故障（如 gpt-5-5 在 eromaa.com 上返回空内容）
   * 需要在外部覆盖。本 flag 在 seedCanonicalFromFixture 后更新所有 project.settings.textModel。
   */
  textModel?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    seed: "",
    maxChapters: 20,
    maxAttempts: 3,
    qualityThreshold: undefined,
    startChapter: 1,
    endChapter: undefined,
    resume: true,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case "--seed": result.seed = next ?? ""; i += 1; break;
      case "--max-chapters": result.maxChapters = Number(next ?? "20"); i += 1; break;
      case "--max-attempts": result.maxAttempts = Number(next ?? "3"); i += 1; break;
      case "--quality-threshold": result.qualityThreshold = Number(next ?? "3.7"); i += 1; break;
      case "--start-chapter": result.startChapter = Number(next ?? "1"); i += 1; break;
      case "--end-chapter": result.endChapter = Number(next); i += 1; break;
      case "--output-dir": result.outputDir = next; i += 1; break;
      case "--run-id": result.runId = next; i += 1; break;
      case "--no-resume": result.resume = false; break;
      case "--dry-run": result.dryRun = true; break;
      case "--json": result.json = true; break;
      case "--api-key": result.apiKey = next; i += 1; break;
      case "--base-url": result.apiBaseUrl = next; i += 1; break;
      case "--chat-model": result.chatModel = next; i += 1; break;
      case "--text-model": result.textModel = next; i += 1; break;
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

  if (!result.seed) {
    console.error("缺少必填参数：--seed <path>");
    console.error("使用 --help 查看完整用法");
    process.exit(2);
  }
  if (!Number.isFinite(result.maxChapters) || result.maxChapters < 1) {
    console.error(`--max-chapters 必须为正整数，当前：${result.maxChapters}`);
    process.exit(2);
  }
  if (!Number.isFinite(result.maxAttempts) || result.maxAttempts < 1) {
    console.error(`--max-attempts 必须为正整数，当前：${result.maxAttempts}`);
    process.exit(2);
  }
  if (result.qualityThreshold !== undefined && !Number.isFinite(result.qualityThreshold)) {
    console.error(`--quality-threshold 必须为数字，当前：${result.qualityThreshold}`);
    process.exit(2);
  }
  if (!Number.isFinite(result.startChapter) || result.startChapter < 1) {
    console.error(`--start-chapter 必须为正整数，当前：${result.startChapter}`);
    process.exit(2);
  }
  if (result.startChapter > result.maxChapters) {
    console.error(`--start-chapter(${result.startChapter}) 不能大于 --max-chapters(${result.maxChapters})`);
    process.exit(2);
  }
  if (result.endChapter !== undefined && (!Number.isInteger(result.endChapter) || result.endChapter < result.startChapter || result.endChapter > result.maxChapters)) {
    console.error(`--end-chapter 必须是 start-chapter..max-chapters 范围内的整数，当前：${result.endChapter}`);
    process.exit(2);
  }

  return result;
}

function printHelp(): void {
  console.log(`
20 章迭代编排 CLI

用法：
  npm run novel:20chapters -- --seed <fixture.json> [options]

必填参数：
  --seed <path>          完整闭环 fixture JSON（由"导出评测快照"生成）

可选参数：
  --max-chapters <n>     生成章节数（默认 20）
  --max-attempts <n>     每章最大重试次数（默认 3）
  --quality-threshold <f> 质量阈值（默认读 project.settings.qualityThreshold）
  --start-chapter <n>    从第几章开始（默认 1，调试用）
  --end-chapter <n>      到第几章结束（默认 max-chapters，调试用）
  --output-dir <path>    产物目录（默认 .novel-bench/runs/lingxu-jianghu-20chapters-<ts>/）
  --run-id <id>          稳定运行 ID；相同 ID 可跨进程恢复（默认根据 seed 与章节范围生成）
  --no-resume            不读 progress.json，从 start-chapter 重新开始
  --dry-run              只验证 start-chapter 的 inspect 与质量分，不 promote（smoke 验证用）
  --json                 输出 JSON 摘要（默认人类可读）
  --api-key <key>        LLM API Key（默认读 process.env.OPENAI_API_KEY）
  --base-url <url>       LLM Base URL（默认读 process.env.OPENAI_BASE_URL）
  --chat-model <id>      Chat 模型 ID（默认读 process.env.CHAT_MODEL 或 gpt-5-5；仅同步到 useUIStore）
  --text-model <id>      覆盖 project.settings.textModel（用于绕过项目内已损坏的模型配置）
  --help, -h             显示本帮助

示例：
  npm run novel:20chapters -- --seed ./灵序江湖.ymcp-evaluation.json
  npm run novel:20chapters -- --seed ./灵序江湖.ymcp-evaluation.json --max-chapters 1 --dry-run
  npm run novel:20chapters -- --seed ./灵序江湖.ymcp-evaluation.json --start-chapter 3 --end-chapter 5
  npm run novel:20chapters -- --seed ./灵序江湖.ymcp-evaluation.json --api-key sk-xxx
`.trim());
}

// ===== Progress 文件 =====

interface ChapterProgress {
  chapterNumber: number;
  chapterId: string;
  threadId: string;
  briefId: string;
  phaseIndex: number;
  attempts: number;
  promoted: boolean;
  finalReceiptStatus: string | undefined;
  finalWeightedScore: number | undefined;
  finalQualityDimensions: Record<string, number> | undefined;
  finalWordCount: number | undefined;
  workflowRunIds: string[];
  canonicalHashBefore: string;
  canonicalHashAfter: string;
  completedAt: number;
}

export interface ProgressFile {
  startedAt: number;
  updatedAt: number;
  projectId: string;
  qualityThreshold: number;
  dryRun: boolean;
  completedChapters: ChapterProgress[];
  failureLog: Array<{ chapterNumber: number; reason: string; timestamp: number }>;
}

export interface RunCheckpoint {
  format: "ymcp-novel-20chapters-checkpoint";
  formatVersion: 1;
  progress: ProgressFile;
  fixture: ClosedLoopFixtureBundle;
}

function loadProgress(progressPath: string): ProgressFile | undefined {
  if (!existsSync(progressPath)) return undefined;
  try {
    return JSON.parse(readFileSync(progressPath, "utf-8")) as ProgressFile;
  } catch {
    return undefined;
  }
}

function saveProgress(progressPath: string, progress: ProgressFile): void {
  progress.updatedAt = Date.now();
  writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function loadCheckpoint(checkpointPath: string): RunCheckpoint | undefined {
  if (!existsSync(checkpointPath)) return undefined;
  try {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf-8")) as RunCheckpoint;
    if (checkpoint.format !== "ymcp-novel-20chapters-checkpoint" || checkpoint.formatVersion !== 1) {
      throw new Error("格式或版本不受支持");
    }
    return checkpoint;
  } catch (error) {
    throw new Error(`checkpoint 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveCheckpoint(checkpointPath: string, progress: ProgressFile, fixture: ClosedLoopFixtureBundle): void {
  const checkpoint: RunCheckpoint = {
    format: "ymcp-novel-20chapters-checkpoint",
    formatVersion: 1,
    progress: structuredClone(progress),
    fixture,
  };
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

export function assertCheckpointMatchesProgress(checkpoint: RunCheckpoint): void {
  const { progress, fixture } = checkpoint;
  const projectId = fixture.snapshot.sourceProjectId;
  if (progress.projectId !== projectId) {
    throw new Error(`checkpoint progress.projectId 不匹配：${progress.projectId} !== ${projectId}`);
  }
  const documents = new Map(fixture.snapshot.records.documents.map((record) => [String(record.id), record]));
  for (const completed of progress.completedChapters) {
    const document = documents.get(completed.chapterId);
    if (!document) throw new Error(`checkpoint 缺少已完成章节：ch ${completed.chapterNumber} (${completed.chapterId})`);
    if (!progress.dryRun && document.status !== "final") {
      throw new Error(`checkpoint 已完成章节不是 final：ch ${completed.chapterNumber} status=${String(document.status)}`);
    }
  }
  const latest = progress.completedChapters.at(-1);
  if (latest && latest.canonicalHashAfter !== fixture.snapshot.manifest.snapshotHash) {
    throw new Error("checkpoint progress 的 canonicalHashAfter 与 fixture snapshotHash 不一致");
  }
}

export function chapterAttemptPassed(input: {
  dryRun: boolean;
  promoted: boolean;
  inspectStatus: string;
  score: number | undefined;
  qualityThreshold: number;
}): boolean {
  return input.score !== undefined
    && input.score >= input.qualityThreshold
    && (input.dryRun ? input.inspectStatus === "ready" : input.promoted);
}

// ===== Phase 映射 =====

/**
 * 把章号映射到 phase index。
 *
 * 算法：均匀分配章节到 phases。
 * phaseIndex = min(phases.length - 1, floor((chapterN - 1) * phases.length / maxChapters))
 *
 * 例如 maxChapters=20, phases.length=5：
 * - ch 1-4 → phase 0
 * - ch 5-8 → phase 1
 * - ch 9-12 → phase 2
 * - ch 13-16 → phase 3
 * - ch 17-20 → phase 4
 */
function resolvePhaseIndex(chapterN: number, maxChapters: number, phasesCount: number): number {
  if (phasesCount === 0) return 0;
  return Math.min(phasesCount - 1, Math.floor((chapterN - 1) * phasesCount / maxChapters));
}

function buildChapterGoal(project: StoryProject, phase: ArchitecturePhase, chapterN: number, phaseStart: number, phaseEnd: number): string {
  const phaseProgress = `（本幕第 ${chapterN - phaseStart + 1} / ${phaseEnd - phaseStart + 1} 章，逐步逼近本幕转折点）`;
  return [
    `完成《${project.title}》第 ${chapterN} 章正文。`,
    `本章属于第 ${phase.order + 1} 幕「${phase.title}」${phaseProgress}。`,
    `本幕主旨：${phase.purpose}`,
    `本幕转折点：${phase.turningPoint}`,
    `生成 ${project.dailyGoal || 3000} 字左右的中文正文，承上启下，推进本幕转折点的呈现。`,
  ].join("\n");
}

// ===== 单章执行 =====

interface ChapterRunResult {
  chapterId: string;
  threadId: string;
  briefId: string;
  attempts: number;
  promoted: boolean;
  finalReceiptStatus: string | undefined;
  finalWeightedScore: number | undefined;
  finalQualityDimensions: Record<string, number> | undefined;
  finalWordCount: number | undefined;
  workflowRunIds: string[];
  canonicalHashBefore: string;
  canonicalHashAfter: string;
}

/**
 * 执行单章编排：createChapter → thread → brief → confirm → runClosedLoop（最多 maxAttempts 次）。
 *
 * 重试策略：
 * - attempt 1 跑 runClosedLoop，检查 receipt.status==='promoted' AND weightedScore >= threshold
 * - 满足则返回；不满足则 attempt+1 重试
 * - maxAttempts 后仍不满足，返回最后一次结果（promoted=false），由调用方决定是否前进
 *
 * 注意：每次重试都基于当前 canonicalDb 状态（含上一次 promote 结果），由 runClosedLoop 内部重新 capture baseline。
 */
async function runSingleChapter(params: {
  projectId: string;
  chapterN: number;
  phaseIndex: number;
  phase: ArchitecturePhase;
  phaseStart: number;
  phaseEnd: number;
  project: StoryProject;
  maxAttempts: number;
  qualityThreshold: number;
  dryRun: boolean;
  authorId: string;
  codeRevision: string;
  log: (msg: string) => void;
}): Promise<ChapterRunResult> {
  const { projectId, chapterN, phase, project, maxAttempts, qualityThreshold, dryRun, authorId, codeRevision, log } = params;

  // 1. 创建章节 document（createChapter 内部按 documents.length 计算 order，N=1 → order=0）
  const document = await createChapter(projectId, `第${chapterN}章`);
  const chapterId = document.id;
  log(`章节创建：order=${document.order} id=${chapterId} title=${document.title}`);

  // 2. 创建/获取 thread（幂等）
  const thread = await novelMemoryService.getOrCreateThread({ projectId, targetDocumentId: chapterId });
  log(`协作 thread：id=${thread.id} status=${thread.status}`);

  // 3. 创建/获取 draft brief 并更新 goal + 确认
  const draftBrief = await novelMemoryService.getDraftBrief(thread.id);
  const goal = buildChapterGoal(project, phase, chapterN, params.phaseStart, params.phaseEnd);
  const updatedBrief = await novelMemoryService.updateBrief(draftBrief.id, {
    goal,
    tone: project.tone || "",
    targetWords: project.dailyGoal || 3000,
    languageRequirements: [project.languageStyle || "具象"].filter(Boolean),
  });
  if (updatedBrief.openQuestions.length > 0) {
    // 清空 openQuestions 使 brief 可确认（auto-resume 场景下可能有遗留）
    await novelMemoryService.updateBrief(updatedBrief.id, { openQuestions: [] });
  }
  const confirmedBrief = await novelMemoryService.confirmBrief(updatedBrief.id);
  log(`brief 确认：id=${confirmedBrief.id} goal 长度=${confirmedBrief.goal.length}`);

  // 4. 重试循环
  let attempts = 0;
  let lastResult: ChapterRunResult | undefined;
  const workflowRunIds: string[] = [];

  while (attempts < maxAttempts) {
    attempts += 1;
    log(`attempt ${attempts}/${maxAttempts}：启动 runClosedLoop（dryRun=${dryRun}）`);
    try {
      const result = await runClosedLoop({
        canonicalDb: novelDb,
        projectId,
        chapterId,
        threadId: thread.id,
        briefId: confirmedBrief.id,
        instruction: confirmedBrief.goal,
        codeRevision,
        authorId,
        dryRun,
      });
      workflowRunIds.push(result.workflowRunId);

      const promoted = result.receipt?.status === "promoted";
      // CandidateBundle 字段为 qualityEvidence（不是 qualityReport），dimensionScores（不是 dimensions）
      const score = result.candidate.qualityEvidence?.weightedScore;
      const dimensions = result.candidate.qualityEvidence?.dimensionScores;
      const wordCount = result.candidate.manuscript?.wordCount;
      log(`attempt ${attempts} 完成：receipt=${result.receipt?.status} score=${score?.toFixed(3) ?? "n/a"} wordCount=${wordCount} hashAdvanced=${result.canonicalHashBefore !== result.canonicalHashAfter}`);
      // inspect 拒绝时打印 check.status + issues + deterministicBlockers + receipt.error，
      // 否则只能看到 receipt=rejected 无法定位 root cause
      if (result.receipt?.status === "rejected") {
        log(`attempt ${attempts} rejected 详情：check.status=${result.check.status} issues=${JSON.stringify(result.check.issues)} deterministicBlockers=${JSON.stringify(result.check.deterministicBlockers)} receipt.error=${result.receipt.error ?? "<no error>"}`);
      }

      lastResult = {
        chapterId,
        threadId: thread.id,
        briefId: confirmedBrief.id,
        attempts,
        promoted,
        finalReceiptStatus: result.receipt?.status,
        finalWeightedScore: score,
        finalQualityDimensions: dimensions,
        finalWordCount: wordCount,
        workflowRunIds: [...workflowRunIds],
        canonicalHashBefore: result.canonicalHashBefore,
        canonicalHashAfter: result.canonicalHashAfter,
      };

      const passed = chapterAttemptPassed({
        dryRun,
        promoted,
        inspectStatus: result.check.status,
        score,
        qualityThreshold,
      });
      if (passed) {
        log(`attempt ${attempts} 达标：score=${score.toFixed(3)} ≥ ${qualityThreshold}${dryRun ? "，dry-run inspect 通过" : "，进入下一章"}`);
        return lastResult;
      }
      if (attempts < maxAttempts) {
        log(`attempt ${attempts} 未达标：${promoted ? `score=${score?.toFixed(3)} < ${qualityThreshold}` : `receipt=${result.receipt?.status}`}，准备重试`);
      }
    } catch (error) {
      // runClosedLoop 偶发失败（例如 LLM 返回空内容、provider 端瞬时故障、工作流 stage
      // 状态机被 failRun）时，不停止整个编排——记录错误后重试，让 maxAttempts 机制兜底。
      // PromotionService 有幂等检查（operationId=promote:<candidateId>），即使 promote
      // 部分执行后重试也不会重复写入。若 maxAttempts 用尽仍失败，由上层 catch 记录
      // failureLog 后停止编排。
      const reason = error instanceof Error ? error.message : String(error);
      log(`attempt ${attempts} 异常：${reason}`);
      lastResult = {
        chapterId,
        threadId: thread.id,
        briefId: confirmedBrief.id,
        attempts,
        promoted: false,
        finalReceiptStatus: "exception",
        finalWeightedScore: undefined,
        finalQualityDimensions: undefined,
        finalWordCount: undefined,
        workflowRunIds: [...workflowRunIds],
        canonicalHashBefore: "",
        canonicalHashAfter: "",
      };
      if (attempts < maxAttempts) {
        log(`attempt ${attempts} 准备重试（偶发错误兜底）`);
      }
    }
  }

  log(`maxAttempts=${maxAttempts} 用尽，本章未达标：promoted=${lastResult?.promoted} score=${lastResult?.finalWeightedScore?.toFixed(3) ?? "n/a"}`);
  return lastResult!;
}

// ===== 主入口 =====

export function resolve20ChapterRunDir(input: {
  seed: string;
  maxChapters: number;
  startChapter: number;
  endChapter?: number;
  dryRun: boolean;
  outputDir?: string;
  runId?: string;
  resume?: boolean;
}): string {
  if (input.outputDir) return resolve(input.outputDir);
  const explicit = input.runId?.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (explicit) return resolve(process.cwd(), ".novel-bench", "runs", `20chapters-${explicit}`);
  if (input.resume !== false) {
    const key = JSON.stringify({
      seed: resolve(process.cwd(), input.seed),
      maxChapters: input.maxChapters,
      startChapter: input.startChapter,
      endChapter: input.endChapter ?? input.maxChapters,
      dryRun: input.dryRun,
    });
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
    return resolve(process.cwd(), ".novel-bench", "runs", `20chapters-${digest}`);
  }
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return join(process.cwd(), ".novel-bench", "runs", `20chapters-${ts}`);
}

function generateRunDir(input: Parameters<typeof resolve20ChapterRunDir>[0]): string {
  const dir = resolve20ChapterRunDir(input);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function run20ChaptersCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const runDir = generateRunDir(args);
  const progressPath = join(runDir, "progress.json");
  const checkpointPath = join(runDir, "checkpoint.json");
  const writeLog = args.json ? console.error : console.log;

  // Polyfill localStorage 必须在任何 LLM 调用前完成
  const polyfillInput: LocalStoragePolyfillInput = {
    apiKey: args.apiKey,
    apiBaseUrl: args.apiBaseUrl,
    chatModel: args.chatModel,
    json: args.json,
  };
  polyfillLocalStorage(polyfillInput);

  // 1. Resume 必须同时恢复进度与正式库，不能只按 progress 跳过章节。
  const checkpoint = args.resume ? loadCheckpoint(checkpointPath) : undefined;
  if (checkpoint) {
    const verification = await verifyClosedLoopFixture(checkpoint.fixture);
    if (!verification.valid) throw new Error(`checkpoint fixture 校验失败：${verification.issues.join("；")}`);
    assertCheckpointMatchesProgress(checkpoint);
    if (checkpoint.progress.dryRun !== args.dryRun) {
      throw new Error(`checkpoint 模式不匹配：checkpoint dryRun=${checkpoint.progress.dryRun}，当前 dryRun=${args.dryRun}`);
    }
    await novelDb.delete();
    await novelDb.open();
    await replaceCanonicalDatabaseFromFixture(checkpoint.fixture, novelDb);
    writeLog(`[20chapters] 已从 checkpoint 恢复正式库：${checkpointPath}`);
  } else {
    await seedCanonicalFromFixture(args.seed, args.json);
  }

  // 2. 读 project + architecture.phases
  const projects = await novelDb.projects.toArray();
  if (projects.length === 0) {
    throw new Error("fixture 中没有 project");
  }
  const project = projects[0]!;
  const projectId = project.id;

  const architectures = await novelDb.architectures.where("projectId").equals(projectId).toArray();
  if (architectures.length === 0) {
    throw new Error(`project ${projectId} 没有 architecture`);
  }
  const architecture = architectures[0]!;
  const phases = [...architecture.phases].sort((a, b) => a.order - b.order);
  if (phases.length === 0) {
    throw new Error(`architecture ${architecture.id} 没有 phases`);
  }

  // 3. 确定质量阈值：CLI flag > project.settings.qualityThreshold > 3.7
  const qualityThreshold = args.qualityThreshold
    ?? project.settings?.qualityThreshold
    ?? 3.7;

  // 4. 确定章节范围
  const startChapter = args.startChapter;
  const requestedEndChapter = args.endChapter ?? args.maxChapters;
  // dry-run 不会晋升章节，无法为后续章节建立 final 前置条件；它只验证当前起始章。
  const endChapter = args.dryRun ? startChapter : requestedEndChapter;

  // 5b. 若指定 --text-model，覆盖所有 project.settings.textModel
  //     用途：项目级 textModel 可能指向已损坏的模型（如 gpt-5-5 在 eromaa.com 返回空内容），
  //     CLI 用户需要在外部强制切换到工作模型（如 gpt-5-3）。
  if (args.textModel && args.textModel.trim()) {
    const overrideModel = args.textModel.trim();
    const allProjects = await novelDb.projects.toArray();
    await novelDb.transaction("rw", novelDb.projects, async () => {
      for (const p of allProjects) {
        if (p.settings?.textModel !== overrideModel) {
          await novelDb.projects.update(p.id, {
            settings: { ...p.settings, textModel: overrideModel },
            updatedAt: Date.now(),
          });
        }
      }
    });
    writeLog(`[20chapters] 已覆盖 project.settings.textModel=${overrideModel}（共 ${allProjects.length} 个 project）`);
  }

  writeLog(`[20chapters] 启动：project=${projectId} title="${project.title}"`);
  writeLog(`[20chapters] phases=${phases.length} qualityThreshold=${qualityThreshold} dryRun=${args.dryRun}`);
  writeLog(`[20chapters] 章节范围：${startChapter}..${endChapter} maxAttempts=${args.maxAttempts}`);
  writeLog(`[20chapters] 产物目录：${runDir}`);

  let progress: ProgressFile;
  if (checkpoint) {
    if (checkpoint.progress.projectId !== projectId) {
      throw new Error(`checkpoint projectId 不匹配：${checkpoint.progress.projectId} !== ${projectId}`);
    }
    progress = checkpoint.progress;
    writeLog(`[20chapters] resume：已从 checkpoint 加载 ${progress.completedChapters.length} 个完成章节`);
  } else if (args.resume && existsSync(progressPath)) {
    const loaded = loadProgress(progressPath);
    if (loaded && loaded.projectId === projectId) {
      if (loaded.dryRun !== args.dryRun) {
        throw new Error(`progress 模式不匹配：progress dryRun=${loaded.dryRun}，当前 dryRun=${args.dryRun}`);
      }
      if (loaded.completedChapters.length > 0) {
        const seededFixture = await captureClosedLoopFixture(novelDb, projectId, "manual");
        const latest = loaded.completedChapters.at(-1)!;
        if (latest.canonicalHashAfter !== seededFixture.snapshot.manifest.snapshotHash) {
          throw new Error("progress.json 缺少匹配的 checkpoint，且 --seed 正式库状态与最后完成章节不一致，拒绝跳过已完成章节");
        }
      }
      progress = loaded;
      writeLog(`[20chapters] resume：已加载 progress.json，已完成 ${progress.completedChapters.length} 章`);
    } else {
      progress = {
        startedAt: Date.now(),
        updatedAt: Date.now(),
        projectId,
        qualityThreshold,
        dryRun: args.dryRun,
        completedChapters: [],
        failureLog: [],
      };
    }
  } else {
    progress = {
      startedAt: Date.now(),
      updatedAt: Date.now(),
      projectId,
      qualityThreshold,
      dryRun: args.dryRun,
      completedChapters: [],
      failureLog: [],
    };
  }

  // 6. 主循环
  const codeRevision = `20chapters-v1`;
  const authorId = `20chapters-orchestrator`;

  for (let chapterN = startChapter; chapterN <= endChapter; chapterN += 1) {
    // Resume：若该章已完成则 skip
    const alreadyDone = progress.completedChapters.find((c) => c.chapterNumber === chapterN);
    if (alreadyDone) {
      writeLog(`[20chapters] ch ${chapterN} 已完成（resume skip）：promoted=${alreadyDone.promoted} score=${alreadyDone.finalWeightedScore?.toFixed(3) ?? "n/a"}`);
      continue;
    }

    const phaseIndex = resolvePhaseIndex(chapterN, args.maxChapters, phases.length);
    const phase = phases[phaseIndex]!;
    // 计算本 phase 的章节范围（仅用于 goal 提示，不影响实际执行）
    const phaseStart = Math.floor(phaseIndex * args.maxChapters / phases.length) + 1;
    const phaseEnd = Math.floor((phaseIndex + 1) * args.maxChapters / phases.length);
    writeLog(`[20chapters] ch ${chapterN} → phase ${phaseIndex}「${phase.title}」(range ${phaseStart}-${phaseEnd})`);

    const log = (msg: string) => writeLog(`[20chapters] ch ${chapterN} ${msg}`);

    try {
      const result = await runSingleChapter({
        projectId,
        chapterN,
        phaseIndex,
        phase,
        phaseStart,
        phaseEnd,
        project,
        maxAttempts: args.maxAttempts,
        qualityThreshold,
        dryRun: args.dryRun,
        authorId,
        codeRevision,
        log,
      });

      const chapterProgress: ChapterProgress = {
        chapterNumber: chapterN,
        chapterId: result.chapterId,
        threadId: result.threadId,
        briefId: result.briefId,
        phaseIndex,
        attempts: result.attempts,
        promoted: result.promoted,
        finalReceiptStatus: result.finalReceiptStatus,
        finalWeightedScore: result.finalWeightedScore,
        finalQualityDimensions: result.finalQualityDimensions,
        finalWordCount: result.finalWordCount,
        workflowRunIds: result.workflowRunIds,
        canonicalHashBefore: result.canonicalHashBefore,
        canonicalHashAfter: result.canonicalHashAfter,
        completedAt: Date.now(),
      };
      progress.completedChapters.push(chapterProgress);

      if ((!args.dryRun && !result.promoted) || (result.finalWeightedScore ?? 0) < qualityThreshold) {
        // "达标才前进"原则：本章未达标时停止整个编排，避免后续章节因 assertPrecedingChaptersFinal
        // 级联失败（前章未 final 会阻塞后章工作流启动）。
        // 不从 completedChapters 移除本章（保留诊断信息），但 resume 时 alreadyDone 判断
        // 会 skip 本章——为支持 resume 重试，把本章从 completedChapters 弹出。
        progress.completedChapters.pop();
        const reason = `maxAttempts=${args.maxAttempts} 用尽，dryRun=${args.dryRun} promoted=${result.promoted} score=${result.finalWeightedScore?.toFixed(3) ?? "n/a"} threshold=${qualityThreshold}`;
        progress.failureLog.push({
          chapterNumber: chapterN,
          reason,
          timestamp: Date.now(),
        });
        saveProgress(progressPath, progress);
        writeLog(`[20chapters] ch ${chapterN} 未达标，停止编排（达标才前进原则）：${reason}`);
        throw new Error(`ch ${chapterN} 未达标，停止编排：${reason}`);
      }

      const checkpointFixture = await captureClosedLoopFixture(novelDb, projectId, "post-bench");
      saveCheckpoint(checkpointPath, progress, checkpointFixture);
      saveProgress(progressPath, progress);
      writeLog(`[20chapters] ch ${chapterN} 进度已保存：promoted=${result.promoted} score=${result.finalWeightedScore?.toFixed(3) ?? "n/a"} wordCount=${result.finalWordCount ?? "n/a"}`);
    } catch (error) {
      const reason = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      // runClosedLoop 内部 startChapterWorkflow 失败时会 failRun 并吞掉原始错误。
      // 主动从 novelDb 读 workflowRun.error 获取真实失败原因。
      let workflowError: string | undefined;
      try {
        const failedRuns = await novelDb.workflowRuns
          .where("status").equals("failed")
          .reverse().sortBy("updatedAt");
        if (failedRuns.length > 0) {
          const latest = failedRuns[0]!;
          workflowError = `workflowRun ${latest.id} stage=${latest.currentStage} error=${String(latest.error ?? "<no error field>")}`;
        }
      } catch (queryError) {
        workflowError = `<查询 workflowRun 失败：${queryError instanceof Error ? queryError.message : String(queryError)}>`;
      }
      const fullReason = workflowError ? `${reason}\n[workflowRun 真实错误] ${workflowError}` : reason;
      progress.failureLog.push({
        chapterNumber: chapterN,
        reason: `异常中断：${fullReason}`,
        timestamp: Date.now(),
      });
      saveProgress(progressPath, progress);
      writeLog(`[20chapters] ch ${chapterN} 异常：${fullReason}`);
      // 异常时停止整个编排（让用户决定是否 resume 重试）
      throw error;
    }
  }

  // 7. 全部完成 → capture final-snapshot.json
  writeLog(`[20chapters] 所有章节完成，开始捕获 final-snapshot...`);
  const finalFixture = await captureClosedLoopFixture(novelDb, projectId, "manual");
  const finalFixturePath = join(runDir, "final-snapshot.json");
  writeFileSync(finalFixturePath, JSON.stringify(finalFixture, null, 2));

  const finalVerification = await verifyClosedLoopFixture(finalFixture);
  if (!finalVerification.valid) {
    writeLog(`[20chapters] ⚠ final-snapshot 校验失败：${finalVerification.issues.join("；")}`);
  }

  // 8. 写 summary.json
  const summary = {
    projectId,
    projectTitle: project.title,
    qualityThreshold,
    dryRun: args.dryRun,
    maxChapters: args.maxChapters,
    maxAttempts: args.maxAttempts,
    completedChapters: progress.completedChapters.length,
    promotedChapters: progress.completedChapters.filter((c) => c.promoted).length,
    thresholdMetChapters: progress.completedChapters.filter((c) => (c.finalWeightedScore ?? 0) >= qualityThreshold).length,
    failureCount: progress.failureLog.length,
    chapterSummaries: progress.completedChapters.map((c) => ({
      chapterNumber: c.chapterNumber,
      phaseIndex: c.phaseIndex,
      attempts: c.attempts,
      promoted: c.promoted,
      finalWeightedScore: c.finalWeightedScore,
      finalWordCount: c.finalWordCount,
      chapterId: c.chapterId,
    })),
    finalSnapshotPath: finalFixturePath,
    finalSnapshotHash: finalFixture.snapshot.manifest.snapshotHash,
    finalSnapshotValid: finalVerification.valid,
    finalDocumentCount: finalFixture.snapshot.records.documents.length,
    finalRevisionCount: finalFixture.snapshot.records.revisions.length,
    finalFactAssertionCount: finalFixture.snapshot.records.factAssertions.length,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));

  // 9. 输出
  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2));
    process.stdout.write("\n");
  } else {
    console.log("");
    console.log("====== 20 章编排完成 ======");
    console.log(`项目：          ${project.title} (${projectId})`);
    console.log(`章节范围：      ${startChapter}..${endChapter}`);
    console.log(`完成章节数：    ${summary.completedChapters}`);
    console.log(`promoted 数：   ${summary.promotedChapters}`);
    console.log(`达标数 (≥${qualityThreshold})：${summary.thresholdMetChapters}`);
    console.log(`失败/未达标：   ${summary.failureCount}`);
    console.log(`最终文档数：    ${summary.finalDocumentCount}`);
    console.log(`最终 revision 数：${summary.finalRevisionCount}`);
    console.log(`最终 factAssertion 数：${summary.finalFactAssertionCount}`);
    console.log(`final snapshot：${finalFixturePath}`);
    console.log(`snapshot hash： ${finalFixture.snapshot.manifest.snapshotHash.slice(0, 16)}...`);
    console.log(`snapshot 校验： ${finalVerification.valid ? "通过" : "失败"}`);
    console.log(`progress.json： ${progressPath}`);
    console.log(`产物目录：      ${runDir}`);
    console.log("===========================");
    if (progress.failureLog.length > 0) {
      console.log("");
      console.log("失败日志：");
      for (const entry of progress.failureLog) {
        console.log(`  ch ${entry.chapterNumber}: ${entry.reason}`);
      }
    }
  }

  // 退出码：所有章节 promoted AND 达标 → 0；否则 1
  if (summary.completedChapters === 0) return 1;
  return summary.thresholdMetChapters === summary.completedChapters ? 0 : 1;
}
