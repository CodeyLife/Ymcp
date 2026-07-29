/* ============================================================
 * WorkflowShowcase — 统一 AIDA 工作流展示页
 * 整合 8 个设计工作包:AIDA / Bento / Quality / Gate / Events / Learning / Design Tokens / 横向滚动防护
 * 严格遵循 gpt-taste: 无 emojis,无工程码暴露,2-3 行 Hero,Bento 零空隙,GSAP 动效
 * ============================================================ */

import { useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import "./showcase.css";
import { STAGE_META, QUALITY_DIMENSIONS } from "./stage-meta";
import {
  MOCK_CHAPTER,
  MOCK_STAGE_STATES,
  MOCK_QUALITY_REPORT,
  MOCK_APPROVAL_GATE,
  MOCK_BLUEPRINT_GATE,
  MOCK_FACT_GATE,
  MOCK_STAGE_EVENTS,
  MOCK_LEARNING,
  type ShowcaseChapter,
  type ShowcaseStageState,
  type ShowcaseQualityReport,
  type ShowcaseApprovalGate,
  type ShowcaseStageEvent,
  type ShowcaseLearning,
  type GateKind,
} from "./mock-data";

gsap.registerPlugin(ScrollTrigger, useGSAP);

interface WorkflowShowcaseProps {
  /** 可选:覆盖 mock 数据,接入真实 v2 API */
  chapter?: ShowcaseChapter;
  stageStates?: ShowcaseStageState[];
  qualityReport?: ShowcaseQualityReport;
  approvalGate?: ShowcaseApprovalGate;
  stageEvents?: ShowcaseStageEvent[];
  learning?: ShowcaseLearning[];
  /** 项目 id(真实集成时用于路由跳转) */
  projectId?: string;
}

export default function WorkflowShowcase(props: WorkflowShowcaseProps) {
  const chapter = props.chapter ?? MOCK_CHAPTER;
  const stageStates = props.stageStates ?? MOCK_STAGE_STATES;
  const qualityReport = props.qualityReport ?? MOCK_QUALITY_REPORT;
  const [approvalGate, setApprovalGate] = useState<ShowcaseApprovalGate>(props.approvalGate ?? MOCK_APPROVAL_GATE);
  const stageEvents = props.stageEvents ?? MOCK_STAGE_EVENTS;
  const learning = props.learning ?? MOCK_LEARNING;

  const heroRef = useRef<HTMLDivElement>(null);
  const bentoRef = useRef<HTMLDivElement>(null);

  /* —— GSAP: Hero 入场动效 —— */
  useGSAP(
    () => {
      if (!heroRef.current) return;
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.from(".ws-hero-eyebrow", { y: 20, opacity: 0, duration: 0.6 })
        .from(".ws-hero-title", { y: 40, opacity: 0, duration: 0.9 }, "-=0.3")
        .from(".ws-hero-subtitle", { y: 20, opacity: 0, duration: 0.7 }, "-=0.5")
        .from(".ws-hero-actions > *", { y: 20, opacity: 0, duration: 0.5, stagger: 0.1 }, "-=0.3");
    },
    { scope: heroRef },
  );

  /* —— GSAP: Bento 卡片依次入场 + scrubbing —— */
  useGSAP(
    () => {
      if (!bentoRef.current) return;
      const cards = gsap.utils.toArray<HTMLElement>(".ws-bento-card");
      cards.forEach((card, index) => {
        gsap.fromTo(
          card,
          { y: 60, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.8,
            ease: "power2.out",
            scrollTrigger: {
              trigger: card,
              start: "top 85%",
              toggleActions: "play none none reverse",
            },
            delay: index * 0.04,
          },
        );
      });
    },
    { scope: bentoRef },
  );

  /* —— 切换门禁类型(展示三种门禁差异化) —— */
  function switchGate(kind: GateKind) {
    if (kind === "blueprint-approval") setApprovalGate(MOCK_BLUEPRINT_GATE);
    else if (kind === "manuscript-approval") setApprovalGate(MOCK_APPROVAL_GATE);
    else if (kind === "fact-approval") setApprovalGate(MOCK_FACT_GATE);
  }

  /* —— 平滑滚动到锚点 —— */
  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="ws-page">
      {/* —— Navigation: 浮动玻璃药丸 —— */}
      <nav className="ws-nav" aria-label="工作流导航">
        <span className="ws-nav-brand">Ymcp · 章节工作流</span>
        <a className="ws-nav-link" onClick={() => scrollToSection("hero")}>概览</a>
        <a className="ws-nav-link" onClick={() => scrollToSection("pipeline")}>流水线</a>
        <a className="ws-nav-link" onClick={() => scrollToSection("quality")}>质量光谱</a>
        <a className="ws-nav-link" onClick={() => scrollToSection("gate")}>审批门禁</a>
        <a className="ws-nav-link" onClick={() => scrollToSection("events")}>事件流</a>
        <button className="ws-nav-cta" onClick={() => scrollToSection("gate")}>处理待审</button>
      </nav>

      {/* —— Attention: Hero —— */}
      <section id="hero" ref={heroRef} className="ws-hero">
        <div className="ws-hero-bg" aria-hidden />
        <div className="ws-hero-content">
          <span className="ws-hero-eyebrow">章节工作流 · 第 {chapter.stageIndex} / {chapter.totalStages} 阶段</span>
          <h1 className="ws-hero-title">
            从冻结上下文到 <span className="ws-hero-title-img" aria-hidden /> 人物完善,<em>十一段链路</em> 一条可恢复的章节生产轨迹。
          </h1>
          <p className="ws-hero-subtitle">{chapter.title} · {chapter.subtitle}</p>
          <div className="ws-hero-actions">
            <button className="ws-btn ws-btn-primary" onClick={() => scrollToSection("gate")}>
              处理「{chapter.stageLabel}」待审 <span aria-hidden>→</span>
            </button>
            <button className="ws-btn ws-btn-ghost" onClick={() => scrollToSection("pipeline")}>
              查看完整流水线
            </button>
          </div>
        </div>
      </section>

      {/* —— Interest: 11 阶段 Bento 全景 —— */}
      <section id="pipeline" ref={bentoRef} className="ws-section">
        <div className="ws-container">
          <span className="ws-section-eyebrow">章节生产流水线</span>
          <h2 className="ws-section-title">十一段链路,五类语义,零空隙全景。</h2>
          <p className="ws-section-lede">
            每个阶段都是一次有据可查的状态变更。上下文冻结收敛输入,创作生成由 AI 主创,人工门禁守住决策,质量保障自审闭环,知识沉淀写入长期记忆。
          </p>
          <BentoPipeline stageStates={stageStates} />
        </div>
      </section>

      {/* —— Desire: 质量光谱 scrubbing —— */}
      <section id="quality" className="ws-section">
        <div className="ws-container">
          <span className="ws-section-eyebrow">质量光谱</span>
          <h2 className="ws-section-title">八个维度,逐维点亮,滚动阅读本章质量。</h2>
          <p className="ws-section-lede">
            五位 reviewer 并行审校加 prose-audit 元审核,产出加权分数与分级 issue。阻断项与主要项触发自动修订,警告项可延缓到后续章节统一处理。
          </p>
          <QualitySpectrum report={qualityReport} />
        </div>
      </section>

      {/* —— Desire: 审批门禁仪式化 —— */}
      <section id="gate" className="ws-section">
        <div className="ws-container">
          <span className="ws-section-eyebrow">人工门禁</span>
          <h2 className="ws-section-title">三种决策时刻,逐张堆叠推入视野。</h2>
          <p className="ws-section-lede">
            蓝图审批守住章节骨架,正文审批逐段确认变更,事实审批决定哪些写入长期记忆。当前章节正等待<em style={{ color: "var(--ws-accent-gate)", fontStyle: "normal" }}> {chapter.stageLabel} </em>。
          </p>
          <GateSwitcher current={approvalGate.kind} onChange={switchGate} />
          <ApprovalGate gate={approvalGate} />
        </div>
      </section>

      {/* —— Desire: 事件流阶段化聚合 —— */}
      <section id="events" className="ws-section">
        <div className="ws-container">
          <span className="ws-section-eyebrow">事件流</span>
          <h2 className="ws-section-title">按阶段聚合,不再看流水账。</h2>
          <p className="ws-section-lede">
            把线性 outbox 事件聚合到 stage 维度。每个阶段卡片展示事件数、产物数、耗时,展开可见自然语言描述的内部事件。
          </p>
          <StageEventsAccordion events={stageEvents} />
        </div>
      </section>

      {/* —— 学习闭环 Infinite Marquee —— */}
      <LearningSection learning={learning} />

      {/* —— Action: Footer CTA —— */}
      <footer className="ws-footer">
        <h2 className="ws-footer-title">
          采纳并推进到<em>事实提取</em>。
        </h2>
        <p className="ws-footer-subtitle">
          当前正文已通过审校与修订,确认后工作流将自动进入 fact-extraction 阶段,从正文提取结构化事实差异并写入长期记忆。
        </p>
        <div className="ws-footer-actions">
          <button className="ws-btn ws-btn-primary" onClick={() => scrollToSection("gate")}>
            采纳正文并继续
          </button>
          <button className="ws-btn ws-btn-ghost" onClick={() => scrollToSection("hero")}>
            返回顶部
          </button>
        </div>
        <div className="ws-footer-links">
          <a>Skill 迭代中心</a>
          <a>Craft Rule 候选</a>
          <a>章节记忆</a>
          <a>项目知识库</a>
          <a>评估闭环</a>
        </div>
      </footer>
    </main>
  );
}

/* ============================================================
 * 子组件: 11 阶段 Bento 全景(工作包 B)
 * 12×6 grid-flow-dense,5 类语义配色,零空隙
 * ============================================================ */

function BentoPipeline({ stageStates }: { stageStates: ShowcaseStageState[] }) {
  const stateMap = Object.fromEntries(stageStates.map((s) => [s.stage, s]));
  return (
    <div className="ws-bento">
      {STAGE_META.map((meta) => {
        const state = stateMap[meta.stage];
        const status = state?.status ?? "pending";
        const isDone = status === "done";
        const isActive = status === "active" || status === "gate-waiting";
        const isGate = meta.category === "gate";
        const isFailed = status === "failed";
        const cardClass = [
          "ws-bento-card",
          meta.spanClass,
          isDone ? "is-done" : "",
          isActive ? "is-active" : "",
          isGate ? "is-gate" : "",
        ].filter(Boolean).join(" ");
        const dotClass = [
          "ws-card-status-dot",
          isDone ? "is-done" : "",
          isActive ? (isGate ? "is-gate" : "is-active") : "",
        ].filter(Boolean).join(" ");
        return (
          <article key={meta.stage} className={cardClass} tabIndex={0}>
            <div className="ws-card-index">阶段 {String(meta.index).padStart(2, "0")} / 11</div>
            <h3 className="ws-card-title">{meta.label}</h3>
            <p className="ws-card-desc">{meta.description}</p>
            <div className="ws-card-meta">
              <span className={dotClass} />
              <span>{state?.durationLabel ?? (isDone ? "已完成" : isActive ? "进行中" : "未开始")}</span>
              <span>·</span>
              <span>{state?.artifactCount ?? 0} 个产物</span>
              {isFailed && <span style={{ color: "var(--ws-status-failed)" }}>· 失败</span>}
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <span className={`ws-card-tag ${meta.tagClass}`}>{meta.categoryLabel}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ============================================================
 * 子组件: 质量光谱 scrubbing(工作包 D)
 * 8 维 Progress 条 + sticky 大分数 + issues Horizontal Accordion
 * ============================================================ */

function QualitySpectrum({ report }: { report: ShowcaseQualityReport }) {
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const spectrumRef = useRef<HTMLDivElement>(null);

  /* —— GSAP: 大分数计数动画 —— */
  useGSAP(
    () => {
      if (!scoreRef.current) return;
      const obj = { val: 0 };
      gsap.to(obj, {
        val: report.weightedScore,
        duration: 2,
        ease: "power2.out",
        onUpdate: () => {
          if (scoreRef.current) scoreRef.current.textContent = obj.val.toFixed(2);
        },
        scrollTrigger: { trigger: scoreRef.current, start: "top 80%", toggleActions: "play none none reverse" },
      });
    },
    { scope: scoreRef, dependencies: [report.weightedScore] },
  );

  /* —— GSAP: 8 维 spectrum scrubbing 揭示 —— */
  useGSAP(
    () => {
      if (!spectrumRef.current) return;
      const fills = gsap.utils.toArray<HTMLElement>(".ws-spectrum-fill");
      fills.forEach((fill, index) => {
        const dimension = fill.dataset.dimension;
        const value = dimension ? report.scores[dimension] ?? 0 : 0;
        gsap.fromTo(
          fill,
          { width: "0%" },
          {
            width: `${(value / 5) * 100}%`,
            duration: 1,
            ease: "power2.out",
            scrollTrigger: {
              trigger: fill,
              start: "top 90%",
              toggleActions: "play none none reverse",
            },
            delay: index * 0.08,
          },
        );
      });
    },
    { scope: spectrumRef, dependencies: [report.scores] },
  );

  return (
    <div className="ws-quality-wrap">
      <div className="ws-quality-score">
        <div>
          <span ref={scoreRef} className="ws-quality-score-num">0.00</span>
          <span className="ws-quality-score-suffix">/ 5.00</span>
        </div>
        <div className="ws-quality-score-label">加权质量分 · 阈值 {report.threshold.toFixed(2)}</div>
        <div className={`ws-quality-passed ${report.passed ? "is-pass" : "is-fail"}`}>
          {report.passed ? "已通过质量门禁" : "未达阈值,需修订"}
        </div>
      </div>

      <div ref={spectrumRef}>
        <div className="ws-spectrum">
          {QUALITY_DIMENSIONS.map((dim) => {
            const value = report.scores[dim.key] ?? 0;
            return (
              <div key={dim.key} className="ws-spectrum-bar">
                <div className="ws-spectrum-label" title={dim.description}>{dim.label}</div>
                <div className="ws-spectrum-track">
                  <div className="ws-spectrum-fill" data-dimension={dim.key} />
                </div>
                <div className="ws-spectrum-value">{value.toFixed(1)}</div>
              </div>
            );
          })}
        </div>

        <div className="ws-quality-issues">
          {report.issues.map((issue) => {
            const isOpen = openIssue === issue.id;
            return (
              <article
                key={issue.id}
                className={`ws-issue-row is-${issue.severity}`}
                onClick={() => setOpenIssue(isOpen ? null : issue.id)}
              >
                <div className="ws-issue-row-head">
                  <span className={`ws-issue-severity is-${issue.severity}`}>{issue.severity}</span>
                  <span className="ws-issue-title">{issue.title}</span>
                </div>
                <p className="ws-issue-desc">{issue.description}</p>
                {isOpen && (
                  <div className="ws-issue-detail">
                    {issue.excerpt && <blockquote>{issue.excerpt}</blockquote>}
                    {issue.rule && <p>规则: <code>{issue.rule}</code></p>}
                    {issue.suggestion && <p>建议: {issue.suggestion}</p>}
                    {issue.rewriteExample && (
                      <p>改写示例: <blockquote>{issue.rewriteExample}</blockquote></p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * 子组件: 门禁切换器(展示三种门禁差异化)
 * ============================================================ */

function GateSwitcher({ current, onChange }: { current: GateKind; onChange: (kind: GateKind) => void }) {
  const options: { kind: GateKind; label: string }[] = [
    { kind: "blueprint-approval", label: "蓝图审批" },
    { kind: "manuscript-approval", label: "正文审批" },
    { kind: "fact-approval", label: "事实审批" },
  ];
  return (
    <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
      {options.map((opt) => (
        <button
          key={opt.kind}
          className={`ws-nav-link ${current === opt.kind ? "is-active" : ""}`}
          onClick={() => onChange(opt.kind)}
          style={{ cursor: "pointer", border: "1px solid var(--ws-glass-border)" }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ============================================================
 * 子组件: 审批门禁仪式化(工作包 C)
 * GSAP Card Stacking + 三种门禁差异化
 * ============================================================ */

function ApprovalGate({ gate }: { gate: ShowcaseApprovalGate }) {
  const gateRef = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState("");

  /* —— GSAP: Card Stacking 入场 —— */
  useGSAP(
    () => {
      if (!gateRef.current) return;
      gsap.fromTo(
        ".ws-gate-card",
        { y: 80, opacity: 0, scale: 0.96 },
        {
          y: 0,
          opacity: 1,
          scale: 1,
          duration: 0.9,
          ease: "power3.out",
          scrollTrigger: {
            trigger: gateRef.current,
            start: "top 75%",
            toggleActions: "play none none reverse",
          },
        },
      );
    },
    { scope: gateRef, dependencies: [gate.kind] },
  );

  return (
    <div ref={gateRef} className="ws-gate-wrap">
      <div className="ws-gate-stack">
        <article className="ws-gate-card">
          <header className="ws-gate-card-head">
            <h3 className="ws-gate-title">
              <em>{gate.title}</em>
            </h3>
            <span className="ws-gate-badge">{gate.badge}</span>
          </header>

          {gate.stats && (
            <div className="ws-gate-stats">
              {gate.stats.map((stat) => (
                <div key={stat.label}>
                  <div className="ws-gate-stat-num">{stat.value}</div>
                  <div className="ws-gate-stat-label">{stat.label}</div>
                </div>
              ))}
            </div>
          )}

          <div className="ws-gate-body">
            <MarkdownLite content={gate.bodyMarkdown} />
          </div>

          {gate.factList && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h4 style={{ fontFamily: "var(--ws-font-display)", color: "var(--ws-text-primary)", marginBottom: "0.75rem" }}>事实列表</h4>
              {gate.factList.map((fact) => (
                <div
                  key={fact.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: "1rem",
                    padding: "0.85rem 1rem",
                    marginBottom: "0.5rem",
                    background: "rgba(0,0,0,0.25)",
                    border: `1px solid ${fact.conflict ? "rgba(239,68,68,0.3)" : "var(--ws-glass-border)"}`,
                    borderRadius: "10px",
                  }}
                >
                  <div>
                    <code style={{ fontFamily: "var(--ws-font-mono)", fontSize: "0.82rem", color: "var(--ws-accent-quality)" }}>{fact.field}</code>
                    <div style={{ fontSize: "0.92rem", color: "var(--ws-text-primary)", marginTop: "0.3rem" }}>{fact.value}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", alignItems: "flex-end" }}>
                    <span className={`ws-issue-severity is-${fact.risk === "high" ? "major" : "warning"}`}>
                      {fact.risk === "high" ? "高风险" : "安全"}
                    </span>
                    <span style={{ fontFamily: "var(--ws-font-mono)", fontSize: "0.72rem", color: "var(--ws-text-tertiary)" }}>
                      {fact.status === "accepted" ? "已采纳" : fact.status === "rejected" ? "已排除" : "待审"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <textarea
            className="ws-gate-feedback"
            placeholder="退回时填写具体修改要求;批准可留空。"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />

          <div className="ws-gate-actions">
            <button className="ws-btn ws-btn-primary">采纳并继续</button>
            <button className="ws-btn ws-btn-ghost">部分采纳</button>
            <button className="ws-btn ws-btn-accent">退回重写</button>
          </div>
        </article>
      </div>
    </div>
  );
}

/* ============================================================
 * 子组件: 事件流阶段化聚合(工作包 E)
 * Horizontal Accordion,按 stage 聚合
 * ============================================================ */

function StageEventsAccordion({ events }: { events: ShowcaseStageEvent[] }) {
  const [openStage, setOpenStage] = useState<string | null>(events[0]?.stage ?? null);

  return (
    <div className="ws-events-accordion">
      {events.map((stageEvent) => {
        const isOpen = openStage === stageEvent.stage;
        return (
          <div key={stageEvent.stage} className={`ws-event-row ${isOpen ? "is-open" : ""}`}>
            <div
              className="ws-event-row-head"
              onClick={() => setOpenStage(isOpen ? null : stageEvent.stage)}
            >
              <span className="ws-event-stage-pill">
                <span className="ws-event-stage-dot" style={{ background: stageEvent.categoryColor }} />
                阶段
              </span>
              <span className="ws-event-stage-name">{stageEvent.stageLabel}</span>
              <span className="ws-event-meta">
                {stageEvent.eventCount} 事件 · {stageEvent.artifactCount} 产物 · {stageEvent.durationLabel}
              </span>
              <span className="ws-event-toggle">+</span>
            </div>
            {isOpen && (
              <div className="ws-event-row-body">
                {stageEvent.events.map((event) => (
                  <div key={event.id} className="ws-event-item">
                    <span className="ws-event-item-icon">{event.icon}</span>
                    <span className="ws-event-item-text">
                      <strong>{event.label}</strong> — {event.summary}
                    </span>
                    <span className="ws-event-item-time">{event.timeLabel}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
 * 子组件: 学习闭环 Infinite Marquee(工作包 F)
 * ============================================================ */

function LearningSection({ learning }: { learning: ShowcaseLearning[] }) {
  // Marquee 需要复制一份实现无缝循环
  const marqueeItems = [...learning, ...learning];
  return (
    <section className="ws-learning-section">
      <div className="ws-learning-marquee">
        {marqueeItems.map((item, index) => (
          <span key={`${item.id}-${index}`} className="ws-learning-chip">
            <span className={`ws-learning-chip-status is-${item.status}`}>
              {item.status === "completed" ? "已沉淀" : item.status === "pending" ? "待回归" : "未触发"}
            </span>
            <span style={{ color: "var(--ws-text-primary)" }}>{item.skillName}</span>
            <span className="ws-text-tertiary">{item.skillVersion}</span>
          </span>
        ))}
      </div>
      <div className="ws-learning-grid">
        {learning.map((item) => (
          <article key={item.id} className="ws-skill-card">
            <h4 className="ws-skill-name">{item.skillName}</h4>
            <div className="ws-skill-version">{item.skillVersion}</div>
            <p className="ws-skill-mechanism">{item.underlyingMechanism}</p>
            <div style={{ marginTop: "0.75rem", fontFamily: "var(--ws-font-mono)", fontSize: "0.72rem", color: "var(--ws-text-tertiary)" }}>
              影响输入类: {item.affectedInputClass}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ============================================================
 * 工具: 极简 Markdown 渲染(只支持 ## / ** / - / 段落)
 * 避免引入额外依赖,满足 gate bodyMarkdown 展示需求
 * ============================================================ */

function MarkdownLite({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={`p-${blocks.length}`}>{renderInline(para.join(" "))}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {list.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };

  lines.forEach((line, index) => {
    if (line.startsWith("## ")) {
      flushPara();
      flushList();
      blocks.push(<h4 key={`h-${index}`}>{line.slice(3)}</h4>);
    } else if (line.startsWith("- ")) {
      flushPara();
      list.push(line.slice(2));
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  });
  flushPara();
  flushList();
  return <>{blocks}</>;
}

function renderInline(text: string): React.ReactNode {
  // 支持 **bold** 简单内联
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} style={{ color: "var(--ws-text-primary)" }}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}


