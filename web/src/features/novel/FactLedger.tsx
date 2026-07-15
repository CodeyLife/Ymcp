import { useMemo, useState } from "react";
import { Empty, Input, Progress, Segmented, Select, Spin, Tag, Tooltip } from "antd";
import {
  AppstoreOutlined,
  ClockCircleOutlined,
  EyeOutlined,
  FileSearchOutlined,
  FilterOutlined,
  ReloadOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { novelDb } from "./db";
import { listFactAssertionsWithMeta, listKnowledgeAssertionsWithMeta, type FactAssertionWithMeta, type KnowledgeAssertionWithMeta } from "./facts";
import type { FactAssertion, FactSubjectKind, FactTimeMode, FactTruthStatus, KnowledgeAssertion } from "./types";

/* ------------------------------------------------------------------ *
 * 常量与色彩编码
 * ------------------------------------------------------------------ */

const TRUTH_LABEL: Record<FactTruthStatus, string> = {
  objective: "客观事实",
  claim: "角色陈述",
  contested: "争议证据",
  "open-question": "开放谜题",
};

const TRUTH_COLOR: Record<FactTruthStatus, string> = {
  objective: "green",
  claim: "blue",
  contested: "red",
  "open-question": "gold",
};

const TRUTH_HEX: Record<FactTruthStatus, string> = {
  objective: "#52c41a",
  claim: "#1677ff",
  contested: "#ff4d4f",
  "open-question": "#faad14",
};

const TIME_LABEL: Record<FactTimeMode, string> = {
  timeless: "永恒",
  point: "时点",
  interval: "区间",
  "open-ended": "开放",
  unknown: "未知",
};

const TIME_GLYPH: Record<FactTimeMode, string> = {
  timeless: "∞",
  point: "•",
  interval: "→",
  "open-ended": "⋯",
  unknown: "?",
};

const SUBJECT_LABEL: Record<FactSubjectKind, string> = {
  project: "项目",
  entity: "实体",
  relation: "关系",
  outline: "大纲",
  scene: "场景",
  thread: "剧情线",
  foreshadowing: "伏笔",
  timeline: "时间线",
};

const SUBJECT_COLOR: Record<FactSubjectKind, string> = {
  project: "default",
  entity: "blue",
  relation: "purple",
  outline: "gold",
  scene: "cyan",
  thread: "geekblue",
  foreshadowing: "magenta",
  timeline: "green",
};

const ASSERTION_STATUS_LABEL: Record<FactAssertion["status"], string> = {
  active: "有效",
  superseded: "已取代",
  stale: "已失效",
  retracted: "已撤回",
};

const ASSERTION_STATUS_COLOR: Record<FactAssertion["status"], string> = {
  active: "green",
  superseded: "default",
  stale: "orange",
  retracted: "red",
};

const STANCE_LABEL: Record<KnowledgeAssertion["stance"], string> = {
  known: "已知",
  suspected: "怀疑",
  mistaken: "误解",
  unknown: "不知",
};

const STANCE_COLOR: Record<KnowledgeAssertion["stance"], string> = {
  known: "green",
  suspected: "gold",
  mistaken: "red",
  unknown: "default",
};

const PROVENANCE_LABEL: Record<FactAssertion["provenance"], string> = {
  "approved-revision": "已批准修订",
  "legacy-artifact": "历史产物",
};

type GroupMode = "chapter" | "truth" | "subject" | "table";
type ViewMode = "facts" | "knowledge";

/* ------------------------------------------------------------------ *
 * 主组件
 * ------------------------------------------------------------------ */

export default function FactLedger({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ViewMode>("facts");
  const [groupMode, setGroupMode] = useState<GroupMode>("chapter");
  const [keyword, setKeyword] = useState("");
  const [truthFilter, setTruthFilter] = useState<FactTruthStatus | "all">("all");
  const [statusFilter, setStatusFilter] = useState<FactAssertion["status"] | "all">("active");
  const [subjectKindFilter, setSubjectKindFilter] = useState<FactSubjectKind | "all">("all");
  const [chapterFilter, setChapterFilter] = useState<string | "all">("all");
  const [selectedFactId, setSelectedFactId] = useState<string | null>(null);

  const factsWithMeta = useLiveQuery(() => listFactAssertionsWithMeta(projectId), [projectId]);
  const knowledgeWithMeta = useLiveQuery(() => listKnowledgeAssertionsWithMeta(projectId), [projectId]);
  const chapters = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).sortBy("order"), [projectId]) ?? [];

  const loading = !factsWithMeta || !knowledgeWithMeta;

  // 筛选后的事实
  const filteredFacts = useMemo<FactAssertionWithMeta[]>(() => {
    if (!factsWithMeta) return [];
    const kw = keyword.trim().toLowerCase();
    return factsWithMeta.filter((item) => {
      if (statusFilter !== "all" && item.assertion.status !== statusFilter) return false;
      if (truthFilter !== "all" && item.assertion.truthStatus !== truthFilter) return false;
      if (subjectKindFilter !== "all" && item.assertion.subject.kind !== subjectKindFilter) return false;
      if (chapterFilter !== "all" && item.assertion.revealedAt?.chapterId !== chapterFilter) return false;
      if (kw) {
        const haystack = `${item.assertion.humanReadable} ${item.assertion.evidence} ${item.assertion.predicate} ${item.subjectName ?? ""} ${item.chapterTitle ?? ""}`.toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    });
  }, [factsWithMeta, keyword, truthFilter, statusFilter, subjectKindFilter, chapterFilter]);

  // 筛选后的角色认知
  const filteredKnowledge = useMemo<KnowledgeAssertionWithMeta[]>(() => {
    if (!knowledgeWithMeta) return [];
    const kw = keyword.trim().toLowerCase();
    return knowledgeWithMeta.filter((item) => {
      if (statusFilter !== "all" && item.assertion.status !== statusFilter) return false;
      if (chapterFilter !== "all" && item.assertion.learnedAt?.chapterId !== chapterFilter) return false;
      if (kw) {
        const haystack = `${item.characterName ?? ""} ${item.factHumanReadable ?? ""} ${item.chapterTitle ?? ""}`.toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    });
  }, [knowledgeWithMeta, keyword, statusFilter, chapterFilter]);

  // 统计指标
  const stats = useMemo(() => {
    const all = factsWithMeta ?? [];
    const byTruth: Record<FactTruthStatus, number> = { objective: 0, claim: 0, contested: 0, "open-question": 0 };
    const byStatus: Record<FactAssertion["status"], number> = { active: 0, superseded: 0, stale: 0, retracted: 0 };
    const bySubjectKind: Record<string, number> = {};
    const byTable: Record<string, number> = {};
    let totalConfidence = 0;
    for (const item of all) {
      byTruth[item.assertion.truthStatus]++;
      byStatus[item.assertion.status]++;
      bySubjectKind[item.assertion.subject.kind] = (bySubjectKind[item.assertion.subject.kind] ?? 0) + 1;
      const table = item.assertion.projection?.targetTable ?? item.assertion.subject.kind;
      byTable[table] = (byTable[table] ?? 0) + 1;
      totalConfidence += item.assertion.confidence;
    }
    return {
      total: all.length,
      byTruth,
      byStatus,
      bySubjectKind,
      byTable,
      avgConfidence: all.length ? totalConfidence / all.length : 0,
      knowledgeTotal: (knowledgeWithMeta ?? []).length,
    };
  }, [factsWithMeta, knowledgeWithMeta]);

  // 事实分组
  const groupedFacts = useMemo(() => {
    const groups = new Map<string, FactAssertionWithMeta[]>();
    for (const item of filteredFacts) {
      let key: string;
      if (groupMode === "chapter") {
        key = item.chapterTitle ? `第 ${(item.chapterOrder ?? 0) + 1} 章 · ${item.chapterTitle}` : "未关联章节";
      } else if (groupMode === "truth") {
        key = TRUTH_LABEL[item.assertion.truthStatus];
      } else if (groupMode === "subject") {
        key = SUBJECT_LABEL[item.assertion.subject.kind];
      } else {
        const table = item.assertion.projection?.targetTable ?? item.assertion.subject.kind;
        key = table;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b, "zh-CN"));
  }, [filteredFacts, groupMode]);

  // 角色认知分组（按角色）
  const groupedKnowledge = useMemo(() => {
    const groups = new Map<string, KnowledgeAssertionWithMeta[]>();
    for (const item of filteredKnowledge) {
      const key = item.characterName ?? "未知角色";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b, "zh-CN"));
  }, [filteredKnowledge]);

  // 选中事实的详情 + 关联角色认知
  const selectedFact = useMemo(() => {
    if (!selectedFactId || !factsWithMeta) return null;
    return factsWithMeta.find((item) => item.assertion.id === selectedFactId) ?? null;
  }, [selectedFactId, factsWithMeta]);

  const selectedKnowledge = useMemo(() => {
    if (!selectedFact || !knowledgeWithMeta) return [];
    return knowledgeWithMeta.filter((item) => item.assertion.factAssertionId === selectedFact.assertion.id);
  }, [selectedFact, knowledgeWithMeta]);

  if (loading) return <div className="novel-fact-ledger-loading"><Spin /><span>加载事实账本</span></div>;

  /* ------------------------------------------------------------------ *
   * 渲染辅助
   * ------------------------------------------------------------------ */

  function renderTruthRing() {
    const total = stats.total || 1;
    const segments = (["objective", "claim", "contested", "open-question"] as FactTruthStatus[]).map((t) => ({
      key: t,
      count: stats.byTruth[t],
      percent: (stats.byTruth[t] / total) * 100,
      color: TRUTH_HEX[t],
      label: TRUTH_LABEL[t],
    }));
    return (
      <div className="novel-fact-truth-ring">
        <Progress
          type="circle"
          percent={100}
          size={96}
          strokeColor="#3a3d40"
          format={() => <div className="novel-fact-ring-center"><strong>{stats.total}</strong><small>条事实</small></div>}
        />
        <div className="novel-fact-truth-segments">
          {segments.map((s) => (
            <Tooltip key={s.key} title={`${s.label}：${s.count} 条 · ${s.percent.toFixed(1)}%`}>
              <div className="novel-fact-truth-segment">
                <span className="novel-fact-segment-bar" style={{ width: `${s.percent}%`, background: s.color }} />
                <span className="novel-fact-segment-label">
                  <i style={{ background: s.color }} />
                  {s.label}
                  <b>{s.count}</b>
                </span>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
    );
  }

  function renderStatPills() {
    const statusEntries = (["active", "superseded", "stale", "retracted"] as FactAssertion["status"][]).map((s) => ({
      key: s,
      label: ASSERTION_STATUS_LABEL[s],
      count: stats.byStatus[s],
      color: ASSERTION_STATUS_COLOR[s],
    }));
    return (
      <div className="novel-fact-stat-pills">
        {statusEntries.map((s) => (
          <button
            key={s.key}
            className={`novel-fact-stat-pill ${statusFilter === s.key ? "active" : ""}`}
            onClick={() => setStatusFilter(statusFilter === s.key ? "all" : s.key)}
          >
            <Tag color={s.color}>{s.label}</Tag>
            <strong>{s.count}</strong>
          </button>
        ))}
        <div className="novel-fact-stat-pill novel-fact-stat-pill-soft">
          <Tag>角色认知</Tag>
          <strong>{stats.knowledgeTotal}</strong>
        </div>
        <div className="novel-fact-stat-pill novel-fact-stat-pill-soft">
          <Tag color="purple">平均置信度</Tag>
          <strong>{(stats.avgConfidence * 100).toFixed(0)}%</strong>
        </div>
      </div>
    );
  }

  function renderFactCard(item: FactAssertionWithMeta) {
    const a = item.assertion;
    const isSelected = selectedFactId === a.id;
    return (
      <article
        key={a.id}
        className={`novel-fact-card ${a.status} ${isSelected ? "selected" : ""}`}
        onClick={() => setSelectedFactId(a.id)}
      >
        <header>
          <Tag color={TRUTH_COLOR[a.truthStatus]}>{TRUTH_LABEL[a.truthStatus]}</Tag>
          <Tag color={SUBJECT_COLOR[a.subject.kind]}>{SUBJECT_LABEL[a.subject.kind]}</Tag>
          <Tag>{TIME_GLYPH[a.timeMode]} {TIME_LABEL[a.timeMode]}</Tag>
          <Tag color={ASSERTION_STATUS_COLOR[a.status]}>{ASSERTION_STATUS_LABEL[a.status]}</Tag>
        </header>
        <p className="novel-fact-card-summary">{a.humanReadable}</p>
        {a.evidence && <blockquote>{a.evidence}</blockquote>}
        <footer>
          {item.subjectName && <span><TeamOutlined /> {item.subjectName}</span>}
          {item.chapterTitle && <span><FileSearchOutlined /> {item.chapterTitle}</span>}
          <span><ClockCircleOutlined /> {TIME_LABEL[a.timeMode]}</span>
          <span className="novel-fact-confidence">置信度 {(a.confidence * 100).toFixed(0)}%</span>
        </footer>
      </article>
    );
  }

  function renderKnowledgeCard(item: KnowledgeAssertionWithMeta) {
    const k = item.assertion;
    return (
      <article key={k.id} className={`novel-fact-knowledge-card ${k.status}`}>
        <header>
          <Tag color={STANCE_COLOR[k.stance]}>{STANCE_LABEL[k.stance]}</Tag>
          <Tag color={ASSERTION_STATUS_COLOR[k.status]}>{ASSERTION_STATUS_LABEL[k.status]}</Tag>
          {item.factTruthStatus && <Tag color={TRUTH_COLOR[item.factTruthStatus]}>{TRUTH_LABEL[item.factTruthStatus]}</Tag>}
        </header>
        <p className="novel-fact-knowledge-summary">{item.factHumanReadable ?? k.factAssertionId}</p>
        {item.chapterTitle && <footer><span><FileSearchOutlined /> 于 {item.chapterTitle}</span></footer>}
      </article>
    );
  }

  function renderFactDetail() {
    if (!selectedFact) {
      return (
        <div className="novel-fact-detail-empty">
          <EyeOutlined />
          <p>从左侧选择一条事实查看完整溯源与角色认知</p>
        </div>
      );
    }
    const a = selectedFact.assertion;
    const objectValue = typeof a.object.value === "string" ? a.object.value : JSON.stringify(a.object.value, null, 2);
    return (
      <div className="novel-fact-detail">
        <header>
          <Tag color={TRUTH_COLOR[a.truthStatus]}>{TRUTH_LABEL[a.truthStatus]}</Tag>
          <Tag color={ASSERTION_STATUS_COLOR[a.status]}>{ASSERTION_STATUS_LABEL[a.status]}</Tag>
          <Tag>{PROVENANCE_LABEL[a.provenance]}</Tag>
          <h3>{a.humanReadable}</h3>
        </header>

        <section className="novel-fact-detail-block">
          <label>主体 Subject</label>
          <div className="novel-fact-detail-row">
            <Tag color={SUBJECT_COLOR[a.subject.kind]}>{SUBJECT_LABEL[a.subject.kind]}</Tag>
            <code>{a.subject.id}</code>
            {selectedFact.subjectName && <span>{selectedFact.subjectName}</span>}
          </div>
        </section>

        <section className="novel-fact-detail-block">
          <label>谓词 Predicate</label>
          <code className="novel-fact-detail-code">{a.predicate}</code>
        </section>

        <section className="novel-fact-detail-block">
          <label>客体 Object（{a.object.kind}）</label>
          <pre className="novel-fact-detail-object">{objectValue}</pre>
        </section>

        <section className="novel-fact-detail-block">
          <label>极性 / 真值 / 时间</label>
          <div className="novel-fact-detail-row">
            <Tag>{a.polarity === "affirmed" ? "肯定" : "否定"}</Tag>
            <Tag color={TRUTH_COLOR[a.truthStatus]}>{TRUTH_LABEL[a.truthStatus]}</Tag>
            <Tag>{TIME_GLYPH[a.timeMode]} {TIME_LABEL[a.timeMode]}</Tag>
          </div>
        </section>

        {a.projection && (
          <section className="novel-fact-detail-block">
            <label>投影 Projection</label>
            <div className="novel-fact-detail-row">
              <Tag color="purple">{a.projection.targetTable}</Tag>
              <code>{a.projection.field}</code>
              {a.projection.targetId && <span>→ {a.projection.targetId}</span>}
            </div>
          </section>
        )}

        <section className="novel-fact-detail-block">
          <label>揭示位置 Revealed At</label>
          <div className="novel-fact-detail-row">
            {selectedFact.chapterTitle && <span><FileSearchOutlined /> 第 {(selectedFact.chapterOrder ?? 0) + 1} 章 · {selectedFact.chapterTitle}</span>}
            {a.revealedAt?.narrativeOrder !== undefined && <Tag>序 {a.revealedAt.narrativeOrder}</Tag>}
            {a.revealedAt?.precision && <Tag>{a.revealedAt.precision}</Tag>}
          </div>
        </section>

        <section className="novel-fact-detail-block">
          <label>来源溯源 Provenance</label>
          <div className="novel-fact-detail-row">
            <Tag>{PROVENANCE_LABEL[a.provenance]}</Tag>
            {selectedFact.sourceChapterTitle && <span>提取自：{selectedFact.sourceChapterTitle}</span>}
            <code title="sourceRevisionId">{a.sourceRevisionId.slice(0, 12)}…</code>
          </div>
          <div className="novel-fact-detail-row">
            <span>候选 ID</span>
            <code title="derivedFromCandidateId">{a.derivedFromCandidateId.slice(0, 12)}…</code>
          </div>
          {a.supersedesId && (
            <div className="novel-fact-detail-row">
              <span>取代</span>
              <code>{a.supersedesId.slice(0, 12)}…</code>
            </div>
          )}
        </section>

        <section className="novel-fact-detail-block">
          <label>证据 Evidence</label>
          <blockquote>{a.evidence}</blockquote>
          {a.paragraph !== undefined && <small>段落 {a.paragraph + 1}</small>}
        </section>

        <section className="novel-fact-detail-block">
          <label>置信度</label>
          <Progress percent={a.confidence * 100} size="small" strokeColor={a.confidence >= 0.9 ? "#52c41a" : a.confidence >= 0.7 ? "#faad14" : "#ff4d4f"} />
        </section>

        <section className="novel-fact-detail-block">
          <label>角色认知（{selectedKnowledge.length}）</label>
          {selectedKnowledge.length === 0 ? (
            <small className="novel-fact-detail-empty-inline">本章未触发角色认知变化</small>
          ) : (
            <ul className="novel-fact-detail-knowledge">
              {selectedKnowledge.map((k) => (
                <li key={k.assertion.id}>
                  <Tag color={STANCE_COLOR[k.assertion.stance]}>{STANCE_LABEL[k.assertion.stance]}</Tag>
                  <strong>{k.characterName ?? k.assertion.characterId.slice(0, 8)}</strong>
                  {k.chapterTitle && <small> · {k.chapterTitle}</small>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  /* ------------------------------------------------------------------ *
   * 主渲染
   * ------------------------------------------------------------------ */

  return (
    <div className="novel-fact-ledger">
      <header className="novel-fact-ledger-header">
        <div className="novel-fact-ledger-title">
          <span>TRUTH LEDGER</span>
          <h3>事实账本</h3>
          <p>已落库的客观事实、角色陈述、争议证据与开放谜题；含角色认知层与来源溯源。</p>
        </div>
        <div className="novel-fact-ledger-stats">
          {renderTruthRing()}
        </div>
      </header>

      {stats.total === 0 && stats.knowledgeTotal === 0 ? (
        <Empty description="尚未提交任何事实。完成章节创作流程的事实审批阶段后，已采纳的事实会在这里累积。" />
      ) : (
        <>
          {renderStatPills()}

          <div className="novel-fact-ledger-toolbar">
            <Segmented
              value={view}
              onChange={(v) => setView(v as ViewMode)}
              options={[
                { value: "facts", label: <><UnorderedListOutlined /> 事实</> },
                { value: "knowledge", label: <><TeamOutlined /> 角色认知</> },
              ]}
            />
            {view === "facts" && (
              <Segmented
                value={groupMode}
                onChange={(v) => setGroupMode(v as GroupMode)}
                options={[
                  { value: "chapter", label: "按章节" },
                  { value: "truth", label: "按真值" },
                  { value: "subject", label: "按主体" },
                  { value: "table", label: "按来源表" },
                ]}
              />
            )}
            <div className="novel-fact-ledger-filters">
              <Input
                allowClear
                prefix={<FilterOutlined />}
                placeholder="搜索事实、证据、角色、章节"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                style={{ width: 240 }}
              />
              {view === "facts" && (
                <>
                  <Select
                    size="middle"
                    style={{ width: 130 }}
                    value={truthFilter}
                    onChange={(v) => setTruthFilter(v as FactTruthStatus | "all")}
                    options={[
                      { value: "all", label: "全部真值" },
                      ...(Object.keys(TRUTH_LABEL) as FactTruthStatus[]).map((t) => ({ value: t, label: TRUTH_LABEL[t] })),
                    ]}
                  />
                  <Select
                    size="middle"
                    style={{ width: 130 }}
                    value={subjectKindFilter}
                    onChange={(v) => setSubjectKindFilter(v as FactSubjectKind | "all")}
                    options={[
                      { value: "all", label: "全部主体" },
                      ...(Object.keys(SUBJECT_LABEL) as FactSubjectKind[]).map((k) => ({ value: k, label: SUBJECT_LABEL[k] })),
                    ]}
                  />
                </>
              )}
              <Select
                size="middle"
                style={{ width: 160 }}
                value={chapterFilter}
                onChange={(v) => setChapterFilter(v as string | "all")}
                options={[
                  { value: "all", label: "全部章节" },
                  ...chapters.map((c) => ({ value: c.id, label: `第 ${c.order + 1} 章 · ${c.title}` })),
                ]}
              />
              {(keyword || truthFilter !== "all" || statusFilter !== "active" || subjectKindFilter !== "all" || chapterFilter !== "all") && (
                <Tooltip title="重置筛选">
                  <button
                    className="novel-fact-reset-btn"
                    onClick={() => { setKeyword(""); setTruthFilter("all"); setStatusFilter("active"); setSubjectKindFilter("all"); setChapterFilter("all"); }}
                  >
                    <ReloadOutlined />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>

          {view === "facts" ? (
            <div className="novel-fact-ledger-grid">
              <aside className="novel-fact-ledger-list">
                {groupedFacts.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合筛选条件的事实" />
                ) : (
                  groupedFacts.map(([groupKey, items]) => (
                    <div key={groupKey} className="novel-fact-group">
                      <header>
                        <AppstoreOutlined />
                        <strong>{groupKey}</strong>
                        <Tag>{items.length}</Tag>
                      </header>
                      {items.map(renderFactCard)}
                    </div>
                  ))
                )}
              </aside>
              <section className="novel-fact-ledger-detail">
                {renderFactDetail()}
              </section>
            </div>
          ) : (
            <div className="novel-fact-ledger-knowledge">
              {groupedKnowledge.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合筛选条件的角色认知" />
              ) : (
                groupedKnowledge.map(([charName, items]) => (
                  <div key={charName} className="novel-fact-group">
                    <header>
                      <TeamOutlined />
                      <strong>{charName}</strong>
                      <Tag>{items.length}</Tag>
                    </header>
                    <div className="novel-fact-knowledge-grid">
                      {items.map(renderKnowledgeCard)}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
