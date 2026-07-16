/**
 * Bench 测试共享工具：fixture 加载/保存、运行目录管理、历史基线索引。
 *
 * 所有切片测试与冒烟测试共享此模块。运行产物写入 `.novel-bench/` 目录，
 * 每次运行一个时间戳子目录，便于历史基线对比。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { novelDb } from "../../db";

// ===== 目录常量 =====
export const FIXTURE_DIR = join(__dirname, "fixtures");
export const BENCH_ROOT = join(process.cwd(), ".novel-bench");
export const RUNS_DIR = join(BENCH_ROOT, "runs");
export const INDEX_PATH = join(BENCH_ROOT, "index.json");

// ===== Fixture 管理 =====

export function loadFixture<T>(name: string): T {
  const path = join(FIXTURE_DIR, name);
  if (!existsSync(path)) {
    throw new Error(
      `Fixture 不存在：${name}。请先运行 npm run test:bench:bootstrap 生成 fixture。`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function fixtureExists(name: string): boolean {
  return existsSync(join(FIXTURE_DIR, name));
}

export function saveFixture(name: string, data: unknown): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(FIXTURE_DIR, name), text);
}

/**
 * 要求 fixture 存在，否则抛出带有指引信息的错误。
 * 用于切片测试前置检查（如 review 切片要求 draft fixture 先生成）。
 */
export function requireFixture(name: string, generatedBy: string): void {
  if (!fixtureExists(name)) {
    throw new Error(
      `缺少 fixture：${name}。请先运行 ${generatedBy} 生成。`,
    );
  }
}

// ===== DB 重置 =====

export async function resetDb(): Promise<void> {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
}

// ===== Foundation Snapshot 加载 =====

/** foundation.json 的结构：project + 9 张地基表数据 */
export interface FoundationSnapshot {
  project: unknown;
  architectures: unknown[];
  entities: unknown[];
  relations: unknown[];
  outlineNodes: unknown[];
  scenes: unknown[];
  plotThreads: unknown[];
  foreshadowing: unknown[];
  timelineEvents: unknown[];
  documents: unknown[];
}

const FOUNDATION_TABLES = [
  "architectures",
  "entities",
  "relations",
  "outlineNodes",
  "scenes",
  "plotThreads",
  "foreshadowing",
  "timelineEvents",
  "documents",
] as const;

/**
 * 将 foundation fixture 加载到 DB（跳过地基 9 阶段）。
 * 供切片测试与冒烟测试使用：加载后 resolveNovelSkills 等依赖 project 记录的函数可正常工作。
 */
export async function loadFoundationIntoDb(snapshot: FoundationSnapshot): Promise<void> {
  if (snapshot.project) await novelDb.projects.put(snapshot.project as never);
  for (const table of FOUNDATION_TABLES) {
    const records = snapshot[table];
    if (records && records.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (novelDb as any)[table].bulkPut(records);
    }
  }
}

// ===== 运行目录管理 =====

export interface BenchContext {
  runId: string;
  outputDir: string;
  /** 写入产物文件到本次运行目录 */
  writeOutput: (filename: string, content: string | object) => void;
  /** 设置/合并 metrics.json 内容 */
  setMetrics: (metrics: Record<string, unknown>) => void;
  /** 设置/合并 meta.json 额外字段 */
  setMeta: (meta: Record<string, unknown>) => void;
}

export interface BenchResult<T> {
  result: T;
  runId: string;
  outputDir: string;
  durationMs: number;
}

interface IndexEntry {
  id: string;
  label: string;
  stage: string;
  timestamp: string;
  durationMs: number;
  metricsSummary: Record<string, unknown>;
  [key: string]: unknown;
}

function generateRunId(label: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${ts}-${label}`;
}

const SUMMARY_KEYS = [
  "wordCount", "weightedScore", "avgScore", "blockerCount", "majorCount",
  "warningCount", "issueCount", "inputTokens", "outputTokens",
  "windowCount", "rejectedWindowCount", "revisionWordCount",
];

function extractSummary(metrics: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of SUMMARY_KEYS) {
    if (key in metrics) summary[key] = metrics[key];
  }
  return summary;
}

function updateIndex(entry: IndexEntry): void {
  mkdirSync(BENCH_ROOT, { recursive: true });
  let index: { runs: IndexEntry[] } = { runs: [] };
  if (existsSync(INDEX_PATH)) {
    try {
      index = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
    } catch {
      // index.json 损坏时重置
    }
  }
  index.runs.push(entry);
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

/**
 * Bench 运行包装器：创建时间戳目录、执行 fn、写入 meta/metrics、更新索引。
 *
 * @example
 * const { result, runId } = await runBench("draft", "draft", async (ctx) => {
 *   const draft = await generateDraft();
 *   ctx.writeOutput("output.md", draft.content);
 *   ctx.setMetrics({ wordCount: draft.wordCount });
 *   return draft;
 * });
 */
export async function runBench<T>(
  label: string,
  stage: string,
  fn: (ctx: BenchContext) => Promise<T>,
): Promise<BenchResult<T>> {
  const runId = generateRunId(label);
  const outputDir = join(RUNS_DIR, runId);
  mkdirSync(outputDir, { recursive: true });

  let metrics: Record<string, unknown> = {};
  let metaExtras: Record<string, unknown> = {};

  const ctx: BenchContext = {
    runId,
    outputDir,
    writeOutput: (filename, content) => {
      const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      const fullPath = join(outputDir, filename);
      // 创建子目录（如 prompts/）以支持 writeOutput("prompts/role.md", ...)
      const parentDir = fullPath.substring(0, fullPath.lastIndexOf(sep));
      if (parentDir && parentDir !== outputDir) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(fullPath, text);
    },
    setMetrics: (m) => { metrics = { ...metrics, ...m }; },
    setMeta: (m) => { metaExtras = { ...metaExtras, ...m }; },
  };

  const start = Date.now();
  const result = await fn(ctx);
  const durationMs = Date.now() - start;

  const timestamp = new Date().toISOString();
  const meta = { id: runId, label, stage, timestamp, durationMs, ...metaExtras };
  writeFileSync(join(outputDir, "meta.json"), JSON.stringify(meta, null, 2));

  const finalMetrics = { ...metrics, durationMs };
  writeFileSync(join(outputDir, "metrics.json"), JSON.stringify(finalMetrics, null, 2));

  updateIndex({
    id: runId,
    label,
    stage,
    timestamp,
    durationMs,
    metricsSummary: extractSummary(finalMetrics),
    ...metaExtras,
  });

  return { result, runId, outputDir, durationMs };
}

// ===== 辅助：console 日志前缀 =====

export function log(stage: string, message: string): void {
  console.log(`[bench:${stage}] ${message}`);
}
