/* ============================================================
 * TextDiff — 修订前后对比视图（无第三方依赖，自实现 LCS 行级 + 词级 diff）
 *
 * 输入 baseText（修订前）与 newText（修订后），输出统一 diff：
 * - 行级：equal / add / del，基于最长公共子序列（LCS）对齐
 * - 词级：成对的删除/新增行内做 token 级高亮，标出真正改动的词
 * - 折叠：连续 > contextLines*2+3 行未更改时折叠为「展开 N 行未更改」
 * ============================================================ */

import { useMemo, useState, type ReactNode } from "react";
import { Segmented } from "antd";
import { DownOutlined, RightOutlined } from "@ant-design/icons";

export interface DiffSegment {
  type: "equal" | "add" | "del";
  text: string;
}

// ---------- 词级 diff（行内高亮） ----------
function tokenize(s: string): string[] {
  // 按非词字符切分但保留分隔符，兼容中英文（中文按字处理）
  const tokens: string[] = [];
  const re = /([A-Za-z0-9_]+|[\u4e00-\u9fff]|[^\sA-Za-z0-9_\u4e00-\u9fff]|\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) tokens.push(m[0]);
  return tokens;
}

export function diffTokens(a: string, b: string): DiffSegment[] {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const m = ta.length;
  const n = tb.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffSegment["type"], text: string) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += text;
    else segs.push({ type, text });
  };
  while (i < m && j < n) {
    if (ta[i] === tb[j]) {
      push("equal", ta[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", ta[i]);
      i++;
    } else {
      push("add", tb[j]);
      j++;
    }
  }
  while (i < m) push("del", ta[i++]);
  while (j < n) push("add", tb[j++]);
  return segs;
}

// ---------- 行级 diff ----------
interface RawLine {
  type: "equal" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
}

function diffLines(oldText: string, newText: string): RawLine[] {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: { type: RawLine["type"]; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: "del", text: a[i++] });
  while (j < n) ops.push({ type: "add", text: b[j++] });

  // 标注行号
  const lines: RawLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.type === "equal") lines.push({ ...op, oldNo: oldNo++, newNo: newNo++ });
    else if (op.type === "del") lines.push({ ...op, oldNo: oldNo++ });
    else lines.push({ ...op, newNo: newNo++ });
  }
  return lines;
}

// ---------- 折叠处理：把连续 equal 行折叠 ----------
interface RenderRow {
  kind: "line" | "collapse";
  line?: RawLine;
  pairWith?: RawLine; // 词级配对的另一行（del 配 add）
  collapsed?: RawLine[];
  key: string;
}

function buildRows(lines: RawLine[], contextLines: number): RenderRow[] {
  // 1) 先把相邻 del+add 配对（用于词级高亮）
  const paired: (RawLine & { pairWith?: RawLine })[] = [];
  let idx = 0;
  while (idx < lines.length) {
    const cur = lines[idx];
    if (cur.type === "del") {
      // 收集连续 del 与其后连续 add
      const dels: RawLine[] = [];
      while (idx < lines.length && lines[idx].type === "del") dels.push(lines[idx++]);
      const adds: RawLine[] = [];
      while (idx < lines.length && lines[idx].type === "add") adds.push(lines[idx++]);
      const max = Math.max(dels.length, adds.length);
      for (let k = 0; k < max; k++) {
        if (k < dels.length) paired.push({ ...dels[k], pairWith: adds[k] });
        if (k >= dels.length && k < adds.length) paired.push({ ...adds[k] });
        else if (k < adds.length) paired.push({ ...adds[k], pairWith: dels[k] });
      }
    } else {
      paired.push({ ...cur });
      idx++;
    }
  }

  // 2) 折叠连续 equal
  const rows: RenderRow[] = [];
  let k = 0;
  let seq = 0;
  while (k < paired.length) {
    if (paired[k].type === "equal") {
      let run: RawLine[] = [];
      while (k < paired.length && paired[k].type === "equal") run.push(paired[k++]);
      const keep = contextLines;
      if (run.length > keep * 2 + 1) {
        run.slice(0, keep).forEach((line) => rows.push({ kind: "line", line, key: `l${seq++}` }));
        rows.push({ kind: "collapse", collapsed: run.slice(keep, run.length - keep), key: `c${seq++}` });
        run.slice(run.length - keep).forEach((line) => rows.push({ kind: "line", line, key: `l${seq++}` }));
      } else {
        run.forEach((line) => rows.push({ kind: "line", line, key: `l${seq++}` }));
      }
      run = [];
    } else {
      rows.push({ kind: "line", line: paired[k], pairWith: paired[k].pairWith, key: `l${seq++}` });
      k++;
    }
  }
  return rows;
}

// ---------- 行内渲染（词级高亮） ----------
function InlineTokens({ base, target, mode }: { base: string; target?: string; mode: "del" | "add" | "equal" }) {
  if (mode === "equal" || target === undefined) return <>{base}</>;
  const segs = diffTokens(base, target);
  return (
    <>
      {segs.map((s, i) => {
        if (mode === "del" && s.type === "add") return null;
        if (mode === "add" && s.type === "del") return null;
        const highlight = (mode === "del" && s.type === "del") || (mode === "add" && s.type === "add");
        return (
          <span key={i} className={highlight ? `td-tok is-${mode}` : undefined}>
            {s.text}
          </span>
        );
      })}
    </>
  );
}

// ---------- 并排（side-by-side）视图 ----------
interface SplitRow {
  kind: "row" | "collapse";
  left?: RawLine;
  right?: RawLine;
  changed?: boolean;
  collapsed?: RawLine[];
  key: string;
}

function buildSplitRows(lines: RawLine[], contextLines: number): SplitRow[] {
  // 1) 对齐：equal → 同行；del/add 段 → 逐行左右对齐
  const aligned: SplitRow[] = [];
  let idx = 0;
  let seq = 0;
  while (idx < lines.length) {
    const cur = lines[idx];
    if (cur.type === "equal") {
      aligned.push({ kind: "row", left: cur, right: cur, key: `r${seq++}` });
      idx++;
    } else {
      const dels: RawLine[] = [];
      while (idx < lines.length && lines[idx].type === "del") dels.push(lines[idx++]);
      const adds: RawLine[] = [];
      while (idx < lines.length && lines[idx].type === "add") adds.push(lines[idx++]);
      const max = Math.max(dels.length, adds.length);
      for (let k = 0; k < max; k++) {
        aligned.push({ kind: "row", left: dels[k], right: adds[k], changed: true, key: `r${seq++}` });
      }
    }
  }
  // 2) 折叠连续未变更行
  const rows: SplitRow[] = [];
  let k = 0;
  while (k < aligned.length) {
    const cur = aligned[k];
    if (!cur.changed) {
      const run: SplitRow[] = [];
      while (k < aligned.length && !aligned[k].changed) run.push(aligned[k++]);
      const keep = contextLines;
      if (run.length > keep * 2 + 1) {
        run.slice(0, keep).forEach((r) => rows.push(r));
        rows.push({ kind: "collapse", collapsed: run.slice(keep, run.length - keep).map((r) => r.left!), key: `c${seq++}` });
        run.slice(run.length - keep).forEach((r) => rows.push(r));
      } else {
        run.forEach((r) => rows.push(r));
      }
    } else {
      rows.push(cur);
      k++;
    }
  }
  return rows;
}

function SplitCell({ line, side, pair }: { line?: RawLine; side: "left" | "right"; pair?: { old: string; new: string } }) {
  if (!line) return <div className="tds-cell is-empty"><span className="td-no" /><span className="tds-text" /></div>;
  const type = side === "left" ? (line.type === "equal" ? "equal" : "del") : line.type === "equal" ? "equal" : "add";
  const no = side === "left" ? line.oldNo : line.newNo;
  let content: ReactNode = line.text;
  if (pair) {
    content = side === "left" ? <InlineTokens base={pair.old} target={pair.new} mode="del" /> : <InlineTokens base={pair.old} target={pair.new} mode="add" />;
  } else if (line.type === "add") {
    content = <InlineTokens base="" target={line.text} mode="add" />;
  }
  return (
    <div className={`tds-cell is-${type}`}>
      <span className="td-no">{no ?? ""}</span>
      <span className="tds-text">{content}</span>
    </div>
  );
}

export interface TextDiffProps {
  baseText: string;
  newText: string;
  contextLines?: number;
  baseLabel?: string;
  newLabel?: string;
  emptyText?: string;
  /** 初始视图模式：统一（unified）或并排（split） */
  defaultView?: "unified" | "split";
}

export function TextDiff({ baseText, newText, contextLines = 3, baseLabel = "修订前", newLabel = "修订后", emptyText = "两段文本一致，无差异", defaultView = "unified" }: TextDiffProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"unified" | "split">(defaultView);
  const lines = useMemo(() => diffLines(baseText, newText), [baseText, newText]);
  const rows = useMemo(() => buildRows(lines, contextLines), [lines, contextLines]);
  const splitRows = useMemo(() => buildSplitRows(lines, contextLines), [lines, contextLines]);
  const hasChange = useMemo(() => rows.some((r) => r.line && r.line.type !== "equal"), [rows]);
  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const r of rows) if (r.line) {
      if (r.line.type === "add") add++;
      else if (r.line.type === "del") del++;
    }
    return { add, del };
  }, [rows]);

  if (!hasChange) {
    return <div className="td-empty">{emptyText}</div>;
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="td-view">
      <div className="td-head">
        <span className="td-stat is-del">− {stats.del} 行</span>
        <span className="td-stat is-add">+ {stats.add} 行</span>
        <span className="td-legend"><span className="td-swatch is-del" /> {baseLabel}</span>
        <span className="td-legend"><span className="td-swatch is-add" /> {newLabel}</span>
        <Segmented
          size="small"
          className="td-viewmode"
          value={viewMode}
          onChange={(v) => setViewMode(v as "unified" | "split")}
          options={[
            { value: "unified", label: "统一" },
            { value: "split", label: "并排" },
          ]}
        />
      </div>

      {viewMode === "unified" ? (
        <div className="td-body">
          {rows.map((row) => {
            if (row.kind === "collapse") {
              const isOpen = expanded.has(row.key);
              return (
                <div key={row.key}>
                  <button type="button" className="td-collapse" onClick={() => toggle(row.key)}>
                    {isOpen ? <DownOutlined /> : <RightOutlined />} {isOpen ? "收起" : `展开 ${row.collapsed?.length ?? 0} 行未更改`}
                  </button>
                  {isOpen &&
                    (row.collapsed ?? []).map((line, i) => (
                      <div key={`${row.key}-${i}`} className="td-line is-equal">
                        <span className="td-no">{line.oldNo ?? ""}</span>
                        <span className="td-no">{line.newNo ?? ""}</span>
                        <span className="td-sign"> </span>
                        <span className="td-text">{line.text}</span>
                      </div>
                    ))}
                </div>
              );
            }
            const line = row.line!;
            return (
              <div key={row.key} className={`td-line is-${line.type}`}>
                <span className="td-no">{line.oldNo ?? ""}</span>
                <span className="td-no">{line.newNo ?? ""}</span>
                <span className="td-sign">{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span>
                <span className="td-text">
                  {line.type === "equal" ? (
                    line.text
                  ) : line.type === "del" ? (
                    <InlineTokens base={line.text} target={row.pairWith?.text} mode="del" />
                  ) : (
                    <InlineTokens base={row.pairWith?.text ?? ""} target={line.text} mode="add" />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="td-body tds-body">
          {splitRows.map((row) => {
            if (row.kind === "collapse") {
              const isOpen = expanded.has(row.key);
              return (
                <div key={row.key}>
                  <button type="button" className="td-collapse" onClick={() => toggle(row.key)}>
                    {isOpen ? <DownOutlined /> : <RightOutlined />} {isOpen ? "收起" : `展开 ${row.collapsed?.length ?? 0} 行未更改`}
                  </button>
                  {isOpen &&
                    (row.collapsed ?? []).map((line, i) => (
                      <div key={`${row.key}-${i}`} className="tds-row">
                        <SplitCell line={line} side="left" />
                        <SplitCell line={line} side="right" />
                      </div>
                    ))}
                </div>
              );
            }
            const pair = row.changed && row.left && row.right ? { old: row.left.text, new: row.right.text } : undefined;
            return (
              <div key={row.key} className="tds-row">
                <SplitCell line={row.left} side="left" pair={pair} />
                <SplitCell line={row.right} side="right" pair={pair} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TextDiff;
