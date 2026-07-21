import { useMemo, useState } from "react";
import { App, Alert, Button, Input, Modal, Select, Segmented, Switch, Tag } from "antd";
import { CheckCircleOutlined, DeleteOutlined, ImportOutlined, SafetyCertificateOutlined, SettingOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { novelDb, updateProject } from "./db";
import { buildDraftTasteProfile, confirmTasteProfile } from "./preferences";
import { importNovelSkill, listAvailableSkills, resolveNovelSkills, setProjectSkill } from "./skills";
import type { NovelSkillCategory, NovelSkillStage } from "./types";
import CraftRuleGovernance from "./CraftRuleGovernance";

const CATEGORY_LABELS: Record<NovelSkillCategory, string> = {
  ideation: "创意定位", "character-world": "人物世界", "long-plan": "长期规划", chapter: "章节设计", drafting: "正文执行", serial: "中文连载", review: "专业审校", memory: "记忆维护",
};
const STAGES: NovelSkillStage[] = ["foundation", "planning", "drafting", "review", "revision", "fact-extraction"];

export default function SkillCenter({ projectId }: { projectId: string }) {
  const { message } = App.useApp();
  const project = useLiveQuery(() => novelDb.projects.get(projectId), [projectId]);
  const skills = useLiveQuery(() => listAvailableSkills(projectId), [projectId]) ?? [];
  const bindings = useLiveQuery(() => novelDb.projectSkills.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const resolved = useLiveQuery(async () => Promise.all(STAGES.map((stage) => resolveNovelSkills({ projectId, stage }))), [projectId, project?.settings.contentProfile, bindings.length]);
  const profiles = useLiveQuery(() => novelDb.tasteProfiles.where("projectId").equals(projectId).reverse().sortBy("updatedAt"), [projectId]) ?? [];
  const [category, setCategory] = useState<NovelSkillCategory | "all">("all");
  const [importOpen, setImportOpen] = useState(false);
  const [importScope, setImportScope] = useState<"user" | "project">("project");
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const enabledIds = useMemo(() => new Set((resolved ?? []).flatMap((item) => item.skills.map((skill) => skill.skillId))), [resolved]);
  const conflicts = useMemo(() => (resolved ?? []).flatMap((item) => item.conflicts).filter((item, index, all) => index === all.findIndex((other) => `${other.skillId}:${other.conflictsWith}` === `${item.skillId}:${item.conflictsWith}`)), [resolved]);
  const visible = skills.filter((skill) => category === "all" || skill.category === category);

  async function performImport() {
    setBusy(true);
    try {
      const skill = await importNovelSkill({ projectId, content: importText, scope: importScope });
      await setProjectSkill(projectId, skill.skillId, true);
      setImportOpen(false); setImportText(""); message.success(`已导入 ${skill.name}`);
    } catch (error) { message.error(error instanceof Error ? error.message : "导入失败"); }
    finally { setBusy(false); }
  }

  if (!project) return null;
  return <div className="novel-view-content novel-skill-center">
    <header className="novel-section-title"><div><span>DECLARATIVE CRAFT</span><h2>Skill 中心</h2><p>项目启用的创作规则会随上下文冻结，并在每次产物中保留版本来源。</p></div><Button type="primary" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>导入 Skill</Button></header>

    <section className="novel-skill-config-strip">
      <label><span>创作配置</span><Select value={project.settings.contentProfile} options={[{ value: "general-serial", label: "通用连载型" }, { value: "progression", label: "升级推进型" }, { value: "emotional", label: "情感剧情型" }]} onChange={(contentProfile) => void updateProject(projectId, { settings: { ...project.settings, contentProfile } })} /></label>
      <label><span>自动修订上限</span><Select value={project.settings.maxAutoRevisions} options={[0, 1, 2, 3].map((value) => ({ value, label: `${value} 轮` }))} onChange={(maxAutoRevisions) => void updateProject(projectId, { settings: { ...project.settings, maxAutoRevisions } })} /></label>
      <label><span>质量阈值</span><Select value={project.settings.qualityThreshold} options={[3.3, 3.5, 3.7, 4, 4.2].map((value) => ({ value, label: `${value} / 5` }))} onChange={(qualityThreshold) => void updateProject(projectId, { settings: { ...project.settings, qualityThreshold } })} /></label>
      <div><SafetyCertificateOutlined /><span>第三方脚本永久禁用</span></div>
    </section>

    {conflicts.length > 0 && <Alert type="error" showIcon message="存在 Skill 冲突" description={conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")} />}

    <CraftRuleGovernance projectId={projectId} />

    <div className="novel-skill-toolbar"><Segmented value={category} onChange={(value) => setCategory(value as NovelSkillCategory | "all")} options={[{ label: "全部", value: "all" }, ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))]} /><span>{enabledIds.size} 项生效 · {skills.length} 项可用</span></div>
    <section className="novel-skill-list">
      {visible.map((skill) => <article key={`${skill.source}:${skill.skillId}`} className={enabledIds.has(skill.skillId) ? "enabled" : ""}>
        <div className="novel-skill-mark">{skill.category.slice(0, 2).toUpperCase()}</div>
        <div><header><strong>{skill.name}</strong><Tag>{skill.version}</Tag><Tag color={skill.source === "builtin" ? "default" : "gold"}>{skill.source === "builtin" ? "内置" : skill.source === "user" ? "用户" : "项目"}</Tag></header><p>{skill.description}</p><footer>{skill.stages.map((stage) => <span key={stage}>{stage}</span>)}{skill.license && <span>{skill.license}</span>}</footer></div>
        <div className="novel-skill-actions"><Switch checked={enabledIds.has(skill.skillId)} onChange={(enabled) => void setProjectSkill(projectId, skill.skillId, enabled)} />{!skill.readonly && <Button danger type="text" icon={<DeleteOutlined />} onClick={() => void novelDb.skills.delete(skill.id)} />}</div>
      </article>)}
    </section>

    <section className="novel-taste-section"><header><div><span>PROJECT-LOCAL CALIBRATION</span><h3>项目写作偏好</h3></div><Button icon={<SettingOutlined />} onClick={async () => { await buildDraftTasteProfile(projectId); message.success("已生成待确认偏好配置"); }}>根据审阅记录生成</Button></header>{profiles.length === 0 ? <p>只有用户确认的项目内偏好才会进入 AI 上下文，不跨项目共享。</p> : profiles.map((profile) => <article key={profile.id}><div><Tag color={profile.status === "confirmed" ? "green" : "gold"}>{profile.status === "confirmed" ? "已确认" : "待确认"}</Tag><p>{profile.summary}</p><small>偏好：{profile.preferredPatterns.join("、") || "暂无"}</small><small>避免：{profile.avoidedPatterns.join("、") || "暂无"}</small></div>{profile.status === "draft" && <Button icon={<CheckCircleOutlined />} onClick={() => void confirmTasteProfile(profile.id)}>确认使用</Button>}</article>)}</section>

    <Modal title="导入声明式 Skill" open={importOpen} onCancel={() => setImportOpen(false)} onOk={() => void performImport()} confirmLoading={busy} okText="校验并导入" width={720}>
      <Segmented value={importScope} onChange={(value) => setImportScope(value as "user" | "project")} options={[{ value: "project", label: "仅当前项目" }, { value: "user", label: "所有项目可用" }]} />
      <Input.TextArea className="novel-skill-import" rows={18} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'---\nskillId: my-writing-rule\nversion: 1.0.0\nname: 我的写作规则\ndescription: 项目专用规则\nlocale: zh-CN\ncategory: drafting\nstages: [drafting, revision]\n---\n在这里写不可执行脚本的创作规则。'} />
    </Modal>
  </div>;
}
