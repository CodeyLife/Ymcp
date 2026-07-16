#!/usr/bin/env node
/**
 * 小说创作 Bench 历史基线对比 CLI
 *
 * 用法：
 *   node scripts/novel-bench/compare.mjs list                    列出所有运行
 *   node scripts/novel-bench/compare.mjs latest [--stage <s>]    最近一次运行的完整指标
 *   node scripts/novel-bench/compare.mjs diff <id1> <id2>        对比两次运行
 *   node scripts/novel-bench/compare.mjs trend [--stage <s>] [--limit N]   指标趋势
 *
 * 仅读取 .novel-bench/ 目录，不修改任何文件。无外部依赖。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BENCH_ROOT = join(process.cwd(), ".novel-bench");
const INDEX_PATH = join(BENCH_ROOT, "index.json");
const RUNS_DIR = join(BENCH_ROOT, "runs");

// ===== IO =====

function loadIndex() {
  if (!existsSync(INDEX_PATH)) return { runs: [] };
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return { runs: [] };
  }
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function loadMetrics(runId) {
  return loadJson(join(RUNS_DIR, runId, "metrics.json")) ?? {};
}

function loadMeta(runId) {
  return loadJson(join(RUNS_DIR, runId, "meta.json")) ?? {};
}

// ===== 辅助 =====

const COL_WIDTHS = { id: 22, label: 12, stage: 12, ts: 20, dur: 10, wc: 8, score: 8 };

function pad(str, width, alignRight = false) {
  const s = String(str ?? "");
  if (s.length > width) return s.slice(0, width - 1) + "…";
  return alignRight ? s.padStart(width) : s.padEnd(width);
}

function formatDuration(ms) {
  if (!ms) return "-";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m${remSec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

function parseArgs(argv) {
  const out = { options: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.options[key] = next;
        i += 1;
      } else {
        out.options[key] = true;
      }
    } else {
      out.positionals.push(arg);
    }
  }
  return out;
}

// ===== 子命令 =====

function cmdList() {
  const { runs } = loadIndex();
  if (runs.length === 0) {
    console.log("（暂无运行记录。运行 npm run test:bench:draft 等命令生成首条基线。）");
    return;
  }

  const header = [
    pad("ID", COL_WIDTHS.id),
    pad("Label", COL_WIDTHS.label),
    pad("Stage", COL_WIDTHS.stage),
    pad("Timestamp", COL_WIDTHS.ts),
    pad("Duration", COL_WIDTHS.dur, true),
    pad("Words", COL_WIDTHS.wc, true),
    pad("Score", COL_WIDTHS.score, true),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const run of runs) {
    const summary = run.metricsSummary ?? {};
    const ts = run.timestamp ? run.timestamp.replace("T", " ").slice(0, 19) : "-";
    console.log([
      pad(run.id, COL_WIDTHS.id),
      pad(run.label, COL_WIDTHS.label),
      pad(run.stage, COL_WIDTHS.stage),
      pad(ts, COL_WIDTHS.ts),
      pad(formatDuration(run.durationMs), COL_WIDTHS.dur, true),
      pad(summary.wordCount ?? "-", COL_WIDTHS.wc, true),
      pad(summary.weightedScore ?? summary.avgScore ?? "-", COL_WIDTHS.score, true),
    ].join("  "));
  }
  console.log(`\n共 ${runs.length} 条记录。`);
}

function cmdLatest(options) {
  const { runs } = loadIndex();
  if (runs.length === 0) {
    console.log("（暂无运行记录。）");
    return;
  }
  let filtered = runs;
  if (options.stage) {
    filtered = runs.filter((r) => r.stage === options.stage);
    if (filtered.length === 0) {
      console.log(`（没有 stage="${options.stage}" 的运行记录。）`);
      return;
    }
  }
  const latest = filtered[filtered.length - 1];
  const meta = loadMeta(latest.id);
  const metrics = loadMetrics(latest.id);

  console.log(`=== ${latest.id} ===`);
  console.log(`label:      ${latest.label}`);
  console.log(`stage:      ${latest.stage}`);
  console.log(`timestamp:  ${latest.timestamp}`);
  console.log(`duration:   ${formatDuration(latest.durationMs)}`);
  if (meta.model) console.log(`model:      ${meta.model}`);
  if (meta.contentProfile) console.log(`profile:    ${meta.contentProfile}`);
  if (Array.isArray(meta.skillIds)) console.log(`skills:     ${meta.skillIds.join(", ")}`);

  console.log("\n--- metrics ---");
  console.log(JSON.stringify(metrics, null, 2));
}

function cmdDiff(positionals) {
  if (positionals.length < 2) {
    console.error("用法: compare.mjs diff <runId1> <runId2>");
    process.exit(1);
  }
  const [id1, id2] = positionals;
  const meta1 = loadMeta(id1);
  const meta2 = loadMeta(id2);
  const m1 = loadMetrics(id1);
  const m2 = loadMetrics(id2);

  if (Object.keys(meta1).length === 0) {
    console.error(`运行不存在：${id1}`);
    process.exit(1);
  }
  if (Object.keys(meta2).length === 0) {
    console.error(`运行不存在：${id2}`);
    process.exit(1);
  }

  console.log(`对比 ${id1}  vs  ${id2}\n`);

  // meta 对比
  console.log("--- meta ---");
  const metaKeys = new Set([...Object.keys(meta1), ...Object.keys(meta2)]);
  for (const key of [...metaKeys].sort()) {
    const v1 = meta1[key];
    const v2 = meta2[key];
    if (JSON.stringify(v1) === JSON.stringify(v2)) continue;
    console.log(`  ${key}: ${JSON.stringify(v1)}  →  ${JSON.stringify(v2)}`);
  }

  // metrics 对比
  console.log("\n--- metrics ---");
  const allKeys = new Set([...Object.keys(m1), ...Object.keys(m2)]);
  const numericKeys = [...allKeys].filter((k) => typeof m1[k] === "number" || typeof m2[k] === "number");
  for (const key of numericKeys.sort()) {
    const v1 = m1[key];
    const v2 = m2[key];
    if (typeof v1 !== "number" && typeof v2 !== "number") continue;
    const n1 = typeof v1 === "number" ? v1 : null;
    const n2 = typeof v2 === "number" ? v2 : null;
    let arrow = "  ";
    let delta = "";
    if (n1 !== null && n2 !== null) {
      const d = n2 - n1;
      const pct = n1 !== 0 ? ` (${(d / n1 * 100).toFixed(1)}%)` : "";
      delta = ` Δ=${d >= 0 ? "+" : ""}${d.toFixed(3)}${pct}`;
      arrow = d > 0 ? "↑" : d < 0 ? "↓" : "=";
    }
    const s1 = n1 !== null ? n1.toFixed(3) : "-";
    const s2 = n2 !== null ? n2.toFixed(3) : "-";
    console.log(`  ${arrow} ${pad(key, 28)}  ${pad(s1, 12, true)}  →  ${pad(s2, 12, true)}${delta}`);
  }
}

function cmdTrend(options) {
  const { runs } = loadIndex();
  if (runs.length === 0) {
    console.log("（暂无运行记录。）");
    return;
  }
  let filtered = runs;
  if (options.stage) {
    filtered = runs.filter((r) => r.stage === options.stage);
    if (filtered.length === 0) {
      console.log(`（没有 stage="${options.stage}" 的运行记录。）`);
      return;
    }
  }
  const limit = options.limit ? parseInt(options.limit, 10) : filtered.length;
  const recent = filtered.slice(-limit);

  const cols = ["id", "stage", "timestamp", "wordCount", "weightedScore", "avgScore", "blockerCount", "majorCount", "issueCount", "durationMs"];
  const widths = { id: 22, stage: 10, timestamp: 20, wordCount: 8, weightedScore: 10, avgScore: 8, blockerCount: 8, majorCount: 8, issueCount: 8, durationMs: 10 };

  const header = cols.map((c) => pad(c, widths[c], c !== "id" && c !== "stage" && c !== "timestamp")).join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const run of recent) {
    const m = loadMetrics(run.id);
    const ts = run.timestamp ? run.timestamp.replace("T", " ").slice(0, 19) : "-";
    const row = [
      pad(run.id, widths.id),
      pad(run.stage, widths.stage),
      pad(ts, widths.timestamp),
      pad(m.wordCount ?? "-", widths.wordCount, true),
      pad(m.weightedScore ?? "-", widths.weightedScore, true),
      pad(m.avgScore ?? "-", widths.avgScore, true),
      pad(m.blockerCount ?? "-", widths.blockerCount, true),
      pad(m.majorCount ?? "-", widths.majorCount, true),
      pad(m.issueCount ?? "-", widths.issueCount, true),
      pad(formatDuration(m.durationMs ?? run.durationMs), widths.durationMs, true),
    ].join("  ");
    console.log(row);
  }
  console.log(`\n共 ${recent.length} 条记录（stage=${options.stage || "all"}）。`);
}

function printHelp() {
  console.log(`小说创作 Bench 历史基线对比 CLI

用法:
  node scripts/novel-bench/compare.mjs <command> [args] [options]

命令:
  list                                    列出所有运行
  latest [--stage <stage>]                最近一次运行的完整指标
  diff <runId1> <runId2>                  对比两次运行的 metrics
  trend [--stage <stage>] [--limit N]     指标趋势

示例:
  node scripts/novel-bench/compare.mjs list
  node scripts/novel-bench/compare.mjs latest --stage draft
  node scripts/novel-bench/compare.mjs diff 20260716-120000-draft 20260716-140000-draft
  node scripts/novel-bench/compare.mjs trend --stage draft --limit 5
`);
}

// ===== 入口 =====

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const { options, positionals } = parseArgs(rest);

switch (cmd) {
  case "list":
    cmdList();
    break;
  case "latest":
    cmdLatest(options);
    break;
  case "diff":
    cmdDiff(positionals);
    break;
  case "trend":
    cmdTrend(options);
    break;
  default:
    printHelp();
    process.exit(cmd ? 1 : 0);
}
