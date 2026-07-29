import { useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import { CameraOutlined, ExperimentOutlined, ReloadOutlined, ThunderboltOutlined, FileTextOutlined, CheckCircleOutlined, SwapOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import "../novel-v2.css";
import { decisionMeta, experimentStatusMeta, receiptStatusMeta, shortId } from "./presentation";

// ===== 类型定义（对齐 V2 API 返回结构）=====
type SnapshotRow = { id: string; project_id: string; hash: string; head: string; created_at: string };
type Experiment = {
  id: string;
  projectId: string;
  schemaName: string;
  baseSnapshotId: string;
  baseSnapshotHash: string;
  status: "active" | "closed" | "deleted";
  createdAt: number;
};
type DocumentSummary = { id: string; title: string; narrativeOrder: number };
type ProjectDetail = { id: string; title: string; documents: DocumentSummary[] };
type PromotableFact = { sourceClaimId: string; payload: { title: string; subjectRefs: string[]; kind: string } };
type IteratedSkill = { id: string; skillId: string; beforePrompt: string; afterPrompt: string; rationale: string };
type CandidateBundle = {
  id: string;
  experimentId: string;
  sourceProjectId: string;
  target: { documentId: string; baseRevision: number; baseContentHash: string };
  manuscript: { title: string; plainText: string; contentHtml: string; wordCount: number; contentHash: string };
  acceptedFacts: PromotableFact[];
  iteratedSkills: IteratedSkill[];
  provenance: { codeRevision: string; createdAt: number; workflowRunId: string };
};
type Receipt = {
  id: string;
  candidateId: string;
  projectId: string;
  status: "promoted" | "rolled-back" | "failed";
  result: { revisionId?: string; skillUpdates?: string[]; factIds?: string[] };
  failureReason?: string;
  createdAt: number;
};

export interface EvaluationPanelProps {
  projectId: string;
}

async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "V2 API 请求失败");
  return body as T;
}

export default function EvaluationPanel({ projectId }: EvaluationPanelProps) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [project, setProject] = useState<ProjectDetail>();
  const [candidates, setCandidates] = useState<CandidateBundle[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [snapshotPayload, setSnapshotPayload] = useState<unknown>();
  const [createExperimentOpen, setCreateExperimentOpen] = useState(false);
  const [experimentSnapshotId, setExperimentSnapshotId] = useState<string>();
  const [selectedExperimentId, setSelectedExperimentId] = useState<string>();
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [generatingCandidate, setGeneratingCandidate] = useState(false);
  const [currentCandidate, setCurrentCandidate] = useState<CandidateBundle>();
  const [expandedManuscript, setExpandedManuscript] = useState(false);
  const [promoteCandidate, setPromoteCandidate] = useState<CandidateBundle>();
  const [promoting, setPromoting] = useState(false);
  const [promoteForm] = Form.useForm<{ authorId: string; decision: "accept" | "reject"; reason: string }>();

  async function loadAll() {
    setLoading(true);
    try {
      const [proj, snap, exp, candidateResult, receiptResult] = await Promise.all([
        readJson<{ project: ProjectDetail }>(`/v2/projects/${encodeURIComponent(projectId)}`),
        readJson<{ snapshots: SnapshotRow[] }>(`/v2/projects/${encodeURIComponent(projectId)}/snapshots`),
        readJson<{ experiments: Experiment[] }>(`/v2/projects/${encodeURIComponent(projectId)}/experiments`),
        readJson<{ candidates: CandidateBundle[] }>(`/v2/projects/${encodeURIComponent(projectId)}/candidates`),
        readJson<{ receipts: Receipt[] }>(`/v2/projects/${encodeURIComponent(projectId)}/receipts`),
      ]);
      setProject(proj.project);
      setSnapshots(snap.snapshots ?? []);
      setExperiments(exp.experiments ?? []);
      setCandidates(candidateResult.candidates ?? []);
      setReceipts(receiptResult.receipts ?? []);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (projectId) void loadAll();
    // TODO P3: loadAll 依赖 projectId，eslint exhaustive-deps 已满足；后续可拆分独立刷新。
  }, [projectId]);

  async function captureSnapshot() {
    setCapturing(true);
    try {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/snapshots`, { method: "POST" });
      message.success("快照已捕获");
      await loadAll();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  }

  async function viewSnapshot(snapshotId: string) {
    try {
      const body = await readJson<{ snapshot: unknown }>(`/v2/snapshots/${encodeURIComponent(snapshotId)}`);
      setSnapshotPayload(body.snapshot);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function createExperiment() {
    if (!experimentSnapshotId) {
      message.warning("请选择快照");
      return;
    }
    try {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: experimentSnapshotId }),
      });
      message.success("实验工作区已创建");
      setCreateExperimentOpen(false);
      setExperimentSnapshotId(undefined);
      await loadAll();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteExperiment(experimentId: string) {
    try {
      await readJson(`/v2/experiments/${encodeURIComponent(experimentId)}`, { method: "DELETE" });
      message.success("实验工作区已删除");
      await loadAll();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function closeExperiment(experimentId: string) {
    try {
      await readJson(`/v2/experiments/${encodeURIComponent(experimentId)}/close`, { method: "POST" });
      message.success("实验工作区已关闭");
      await loadAll();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function generateCandidate() {
    if (!selectedExperimentId || !selectedDocumentId) {
      message.warning("请选择实验与章节");
      return;
    }
    setGeneratingCandidate(true);
    try {
      const body = await readJson<{ candidate: CandidateBundle }>(
        `/v2/experiments/${encodeURIComponent(selectedExperimentId)}/candidate`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentId: selectedDocumentId }) },
      );
      setCurrentCandidate(body.candidate);
      setCandidates((prev) => [body.candidate, ...prev.filter((c) => c.id !== body.candidate.id)]);
      setExpandedManuscript(false);
      message.success("候选包已生成");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingCandidate(false);
    }
  }

  async function submitPromotion(values: { authorId: string; decision: "accept" | "reject"; reason: string }) {
    if (!promoteCandidate) return;
    setPromoting(true);
    try {
      const body = await readJson<{ receipt: Receipt }>(
        `/v2/candidates/${encodeURIComponent(promoteCandidate.id)}/promote`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) },
      );
      setReceipts((prev) => [body.receipt, ...prev.filter((r) => r.id !== body.receipt.id)]);
      message.success("晋升完成");
      setPromoteCandidate(undefined);
      promoteForm.resetFields();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPromoting(false);
    }
  }

  const documentOptions = (project?.documents ?? []).map((d) => ({ value: d.id, label: `第 ${d.narrativeOrder} 章 · ${d.title}` }));
  const snapshotOptions = snapshots.map((s) => ({ value: s.id, label: `快照 ${shortId(s.id)} · ${shortId(s.hash, 8)}` }));
  const manuscriptPreview = currentCandidate
    ? expandedManuscript
      ? currentCandidate.manuscript.plainText
      : currentCandidate.manuscript.plainText.slice(0, 500)
    : "";
  const activeExperimentCount = experiments.filter((e) => e.status === "active").length;

  return (
    <div className="novel-eval-page">
      {/* ===== EDITORIAL TOPBAR ===== */}
      <motion.header
        className="novel-topbar"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="novel-topbar-body" style={{ minWidth: 0 }}>
          <span className="novel-eyebrow">评估闭环</span>
          <h2 className="novel-display-h2" style={{ marginTop: 2 }}>
            实验工作区 · 候选晋升
          </h2>
          <p className="novel-lede" style={{ margin: "8px 0 0" }}>
            捕获项目快照，在隔离实验工作区中生成候选稿件，审核采纳事实与技能迭代，最终晋升为正式修订或回滚。
          </p>
        </div>
        <div className="novel-topbar-actions">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadAll()}>刷新</Button>
          <Button type="primary" icon={<CameraOutlined />} loading={capturing} onClick={() => void captureSnapshot()}>捕获快照</Button>
        </div>
      </motion.header>

      {error && <Alert type="error" showIcon message={error} className="novel-v2-alert" closable onClose={() => setError(undefined)} />}

      {/* ===== STATS BENTO ===== */}
      <motion.section
        className="novel-bento"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="novel-card-mini novel-bento-mini">
          <div className="novel-card-mini-label"><CameraOutlined /> 项目快照</div>
          <div className="novel-card-mini-value">{snapshots.length}</div>
          <div className="novel-card-mini-hint">捕获时间线锚点</div>
        </div>
        <div className="novel-card-mini novel-bento-mini">
          <div className="novel-card-mini-label"><ExperimentOutlined /> 实验工作区</div>
          <div className="novel-card-mini-value">{experiments.length}</div>
          <div className="novel-card-mini-hint">{activeExperimentCount} 个活跃 · {experiments.length - activeExperimentCount} 个已关闭/删除</div>
        </div>
        <div className="novel-card-mini novel-bento-mini">
          <div className="novel-card-mini-label"><FileTextOutlined /> 候选包</div>
          <div className="novel-card-mini-value">{candidates.length}</div>
          <div className="novel-card-mini-hint">待晋升 / 已生成候选稿件</div>
        </div>
        <div className="novel-card-mini novel-bento-mini">
          <div className="novel-card-mini-label"><CheckCircleOutlined /> 晋升收据</div>
          <div className="novel-card-mini-value">{receipts.length}</div>
          <div className="novel-card-mini-hint">
            {receipts.filter((r) => r.status === "promoted").length} 成功 · {receipts.filter((r) => r.status === "rolled-back").length} 回滚
          </div>
        </div>
      </motion.section>

      {/* ===== 2-COLUMN WORKSPACE ===== */}
      <section className="novel-eval-workspace">
        {/* 左栏：候选包焦点卡 */}
        <motion.section
          className="novel-eval-focal"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="novel-focal-card">
            <div className="novel-focal-card-head">
              <h3>生成候选包</h3>
              <span className="novel-status-pill novel-status-pill-done">隔离实验 · 不影响主线</span>
            </div>
            <div className="novel-focal-card-body">
              <Select
                style={{ width: "100%" }}
                placeholder="选择实验工作区"
                value={selectedExperimentId}
                onChange={setSelectedExperimentId}
                options={experiments.map((e) => {
                  const stMeta = experimentStatusMeta(e.status);
                  return { value: e.id, label: `${shortId(e.id)} · ${stMeta.label}` };
                })}
              />
              <Select
                style={{ width: "100%" }}
                placeholder="选择章节目标"
                value={selectedDocumentId}
                onChange={setSelectedDocumentId}
                options={documentOptions}
              />
              <Button type="primary" size="large" icon={<ThunderboltOutlined />} loading={generatingCandidate} block onClick={() => void generateCandidate()}>
                生成候选
              </Button>
            </div>
          </div>

          {/* 候选预览 —— 支撑卡 */}
          <div className="novel-card-support">
            <div className="novel-card-head">
              <h3 className="novel-display-h3">候选预览</h3>
              {currentCandidate && (
                <Space size={6}>
                  <Tag color="blue">{shortId(currentCandidate.id)}</Tag>
                  <Tag>{currentCandidate.manuscript.wordCount} 字</Tag>
                </Space>
              )}
            </div>
            {currentCandidate ? (
              <div className="novel-candidate-preview">
                <Typography.Title level={5} style={{ color: "#f4f4f5", margin: "0 0 8px" }}>
                  {currentCandidate.manuscript.title}
                </Typography.Title>
                <div className="novel-manuscript-text">
                  {manuscriptPreview}
                  {currentCandidate.manuscript.plainText.length > 500 && (
                    <Button type="link" size="small" onClick={() => setExpandedManuscript(!expandedManuscript)}>{expandedManuscript ? "收起" : "展开全文"}</Button>
                  )}
                </div>

                <div className="novel-section-label" style={{ margin: "18px 0 10px" }}>
                  Accepted Facts（{currentCandidate.acceptedFacts.length}）
                </div>
                {currentCandidate.acceptedFacts.length ? (
                  <div className="novel-fact-list">
                    {currentCandidate.acceptedFacts.map((f) => (
                      <div key={f.sourceClaimId} className="novel-fact-item">
                        <Tag color="blue">{f.payload.kind}</Tag>
                        <Typography.Text strong>{f.payload.title}</Typography.Text>
                        <Typography.Text type="secondary"> · {f.payload.subjectRefs.join(", ") || "无主体"}</Typography.Text>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="novel-empty" style={{ padding: "12px 8px", textAlign: "center" }}><div className="novel-empty-desc" style={{ fontSize: 12 }}>无采纳事实</div></div>
                )}

                <div className="novel-section-label" style={{ margin: "18px 0 10px" }}>
                  Iterated Skills（{currentCandidate.iteratedSkills.length}）
                </div>
                {currentCandidate.iteratedSkills.length ? (
                  <div className="novel-skill-list">
                    {currentCandidate.iteratedSkills.map((s) => (
                      <div key={s.id} className="novel-skill-item">
                        <div className="novel-skill-item-head"><SwapOutlined /> <Typography.Text strong>{s.skillId}</Typography.Text></div>
                        <div className="novel-skill-diff">
                          <div className="novel-skill-diff-before"><Typography.Text delete type="secondary">{s.beforePrompt.slice(0, 200) || "（空）"}</Typography.Text></div>
                          <div className="novel-skill-diff-after"><Typography.Text type="success">{s.afterPrompt.slice(0, 200) || "（空）"}</Typography.Text></div>
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.rationale}</Typography.Text>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="novel-empty" style={{ padding: "12px 8px", textAlign: "center" }}><div className="novel-empty-desc" style={{ fontSize: 12 }}>无技能迭代</div></div>
                )}
              </div>
            ) : (
              <div className="novel-empty" style={{ padding: "40px 16px", textAlign: "center" }}>
                <div className="novel-empty-mark"><ThunderboltOutlined /></div>
                <div className="novel-empty-title" style={{ marginTop: 12 }}>等待候选</div>
                <div className="novel-empty-desc">选择实验与章节后生成候选包，预览 manuscript / acceptedFacts / iteratedSkills。</div>
              </div>
            )}
          </div>
        </motion.section>

        {/* 右栏：数据密集区 */}
        <motion.aside
          className="novel-eval-observer"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* 快照列表 */}
          <Card
            title={<Space><CameraOutlined /><span>快照列表</span></Space>}
            extra={<Tag>{snapshots.length}</Tag>}
            className="novel-v2-card novel-eval-data-card"
            size="small"
          >
            <Table<SnapshotRow>
              rowKey="id"
              dataSource={snapshots}
              loading={loading}
              size="small"
              pagination={{ pageSize: 4 }}
              columns={[
                { title: "快照", dataIndex: "id", render: (v: string) => <code>{shortId(v)}</code> },
                { title: "Hash", dataIndex: "hash", render: (v: string) => <span className="novel-table-cell-sub">{shortId(v, 8)}</span> },
                { title: "创建时间", dataIndex: "created_at", render: (v: string) => <span className="novel-table-cell-sub">{new Date(v).toLocaleString("zh-CN")}</span> },
                { title: "操作", render: (_v, row) => <Button type="link" size="small" onClick={() => void viewSnapshot(row.id)}>查看</Button> },
              ]}
            />
          </Card>

          {/* 实验工作区 */}
          <Card
            title={<Space><ExperimentOutlined /><span>实验工作区</span></Space>}
            extra={<Button size="small" type="primary" icon={<ExperimentOutlined />} onClick={() => setCreateExperimentOpen(true)}>创建</Button>}
            className="novel-v2-card novel-eval-data-card"
            size="small"
          >
            <Table<Experiment>
              rowKey="id"
              dataSource={experiments}
              loading={loading}
              size="small"
              pagination={{ pageSize: 4 }}
              columns={[
                { title: "实验", dataIndex: "id", render: (v: string) => <code>{shortId(v)}</code> },
                { title: "Schema", dataIndex: "schemaName", render: (v: string) => <span className="novel-table-cell-sub">{v}</span> },
                { title: "状态", dataIndex: "status", render: (v: string) => { const m = experimentStatusMeta(v); return <Tag color={m.tag}>{m.label}</Tag>; } },
                { title: "创建时间", dataIndex: "createdAt", render: (v: number) => <span className="novel-table-cell-sub">{new Date(v).toLocaleString("zh-CN")}</span> },
                {
                  title: "操作",
                  render: (_v, row) => (
                    <Space size={4}>
                      <Button size="small" disabled={row.status === "closed"} onClick={() => void closeExperiment(row.id)}>关闭</Button>
                      <Popconfirm title="删除实验工作区？" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void deleteExperiment(row.id)}>
                        <Button size="small" danger>删除</Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          {/* 候选包列表 */}
          <Card
            title={<Space><FileTextOutlined /><span>候选包列表</span></Space>}
            extra={<Tag>{candidates.length}</Tag>}
            className="novel-v2-card novel-eval-data-card"
            size="small"
          >
            <Table<CandidateBundle>
              rowKey="id"
              dataSource={candidates}
              size="small"
              pagination={{ pageSize: 4 }}
              locale={{ emptyText: "暂无候选包，请在左侧生成" }}
              columns={[
                { title: "候选包", dataIndex: "id", render: (v: string) => <code>{shortId(v)}</code> },
                { title: "实验", dataIndex: "experimentId", render: (v: string) => <span className="novel-table-cell-sub">{shortId(v)}</span> },
                { title: "章节", render: (_v, row) => <span className="novel-table-cell-sub">{shortId(row.target.documentId)}</span> },
                { title: "创建时间", render: (_v, row) => <span className="novel-table-cell-sub">{new Date(row.provenance.createdAt).toLocaleString("zh-CN")}</span> },
                {
                  title: "操作",
                  render: (_v, row) => <Button size="small" type="primary" onClick={() => setPromoteCandidate(row)}>晋升</Button>,
                },
              ]}
            />
          </Card>

          {/* 收据列表 */}
          <Card
            title={<Space><CheckCircleOutlined /><span>晋升收据</span></Space>}
            extra={<Tag>{receipts.length}</Tag>}
            className="novel-v2-card novel-eval-data-card"
            size="small"
          >
            {receipts.length ? (
              <div className="novel-receipt-list">
                {receipts.slice(0, 6).map((r) => {
                  const rMeta = receiptStatusMeta(r.status);
                  return (
                  <div key={r.id} className="novel-receipt-item">
                    <div className="novel-receipt-item-head">
                      <span className={rMeta.pill}>
                        {rMeta.icon}
                        <span style={{ marginLeft: 4 }}>{rMeta.label}</span>
                      </span>
                      <code>{shortId(r.id)}</code>
                    </div>
                    <div className="novel-receipt-item-meta">
                      候选包 {shortId(r.candidateId)} · {new Date(r.createdAt).toLocaleString("zh-CN")}
                    </div>
                    {r.failureReason && <div className="novel-receipt-item-reason">{r.failureReason}</div>}
                  </div>
                  );
                })}
              </div>
            ) : (
              <div className="novel-empty" style={{ padding: "20px 8px", textAlign: "center" }}><div className="novel-empty-desc">暂无收据</div></div>
            )}
          </Card>
        </motion.aside>
      </section>

      {/* 快照 payload 弹窗 */}
      <Modal title="快照 Payload" open={Boolean(snapshotPayload)} onCancel={() => setSnapshotPayload(undefined)} footer={null} width={720} destroyOnHidden>
        <pre style={{ maxHeight: 420, overflow: "auto", padding: 12, background: "rgba(9,9,11,0.62)", borderRadius: 8, fontSize: 12, color: "#a1a1aa" }}>{snapshotPayload ? JSON.stringify(snapshotPayload, null, 2) : ""}</pre>
      </Modal>

      {/* 创建实验弹窗 */}
      <Modal title="创建实验工作区" open={createExperimentOpen} onCancel={() => setCreateExperimentOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical">
          <Form.Item label="选择快照" required>
            <Select placeholder="选择项目快照" value={experimentSnapshotId} onChange={setExperimentSnapshotId} options={snapshotOptions} />
          </Form.Item>
          <Button type="primary" block onClick={() => void createExperiment()}>创建实验</Button>
        </Form>
      </Modal>

      {/* 晋升弹窗：AuthorDecision */}
      <Modal title="确认晋升" open={Boolean(promoteCandidate)} onCancel={() => setPromoteCandidate(undefined)} footer={null} destroyOnHidden>
        {promoteCandidate && (
          <Form form={promoteForm} layout="vertical" initialValues={{ decision: "accept" }} onFinish={(values) => void submitPromotion(values)}>
            <Form.Item label="候选包"><Typography.Text code>{shortId(promoteCandidate.id, 12)}</Typography.Text></Form.Item>
            <Form.Item name="authorId" label="作者 ID" rules={[{ required: true, message: "请输入作者 ID" }]}><Input placeholder="author" /></Form.Item>
            <Form.Item name="decision" label="决策" rules={[{ required: true }]}>
              <Select options={[{ value: "accept", label: decisionMeta("accept").label }, { value: "reject", label: decisionMeta("reject").label }]} />
            </Form.Item>
            <Form.Item name="reason" label="理由"><Input.TextArea rows={3} /></Form.Item>
            <Button type="primary" htmlType="submit" block loading={promoting}>提交晋升</Button>
          </Form>
        )}
      </Modal>
    </div>
  );
}
