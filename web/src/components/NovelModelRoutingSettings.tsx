import { useEffect, useState } from "react";
import { ApiOutlined, CloseOutlined, DeleteOutlined, EditOutlined, ExperimentOutlined, HolderOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Alert, App, AutoComplete, Button, Dropdown, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import { Reorder } from "motion/react";
import { requestJson } from "../lib/json-response";

const { Text, Title } = Typography;

const PURPOSES = [
  "planning.foundation", "planning.blueprint", "writing.draft", "writing.revision",
  "review.style", "review.character", "review.continuity", "review.plot", "review.reader", "review.foundation",
  "facts.extract", "learning.assess", "skill.iterate", "memory.embed", "memory.rerank",
] as const;
type Purpose = (typeof PURPOSES)[number];

const PURPOSE_LABELS: Record<Purpose, string> = {
  "planning.foundation": "规划·基础设定",
  "planning.blueprint": "规划·章节蓝图",
  "writing.draft": "写作·初稿生成",
  "writing.revision": "写作·润色修订",
  "review.style": "审校·文风",
  "review.character": "审校·人物",
  "review.continuity": "审校·连贯性",
  "review.plot": "审校·情节",
  "review.reader": "审校·读者视角",
  "review.foundation": "审校·全书架构",
  "facts.extract": "事实·抽取",
  "learning.assess": "学习·评估",
  "skill.iterate": "技能·迭代",
  "memory.embed": "记忆·向量化",
  "memory.rerank": "记忆·重排",
};

// 与后端 model-routing.ts 的 PURPOSE_CAPABILITY 保持一致：每个 purpose 要求的最低能力
const PURPOSE_CAPABILITY: Record<Purpose, Capability> = {
  "planning.foundation": "structured",
  "planning.blueprint": "structured",
  "writing.draft": "text",
  "writing.revision": "text",
  "review.style": "structured",
  "review.character": "structured",
  "review.continuity": "structured",
  "review.plot": "structured",
  "review.reader": "structured",
  "review.foundation": "structured",
  "facts.extract": "structured",
  "learning.assess": "structured",
  "skill.iterate": "structured",
  "memory.embed": "embedding",
  "memory.rerank": "rerank",
};
type Capability = "text" | "structured" | "stream" | "responses-continuation" | "embedding" | "rerank";
type Candidate = { executor: "api"; profileId: string; model?: string } | { executor: "external-mcp" };
type Route = { candidates: Candidate[]; conversationPolicy?: "stateless" | "task-chain"; maxInputTokens?: number; maxOutputTokens?: number };
type Profile = {
  id: string; label: string; protocol: "chat-completions" | "responses"; baseUrl: string; model: string;
  responseMode?: "json" | "sse"; capabilities: Capability[]; enabled: boolean; timeoutMs?: number; contextWindow?: number;
  hasSecret?: boolean; secretSource?: "inline" | "env"; secretHint?: string;
  secret?: { source: "inline"; value: string } | { source: "env"; name: string };
};
type Config = { version: 1; profiles: Profile[]; routes: Record<string, Route>; snapshotId?: string };

function candidateValue(candidate: Candidate) { return candidate.executor === "external-mcp" ? "external-mcp" : `api:${candidate.profileId}`; }
function fromCandidateValue(value: string): Candidate { return value === "external-mcp" ? { executor: "external-mcp" } : { executor: "api", profileId: value.slice(4) }; }
function inheritedRoute(config: Config | undefined, purpose: Purpose): Route {
  const routes = config?.routes;
  return routes?.[purpose] ?? routes?.[`${purpose.split(".")[0]}.*`] ?? routes?.["*"] ?? { candidates: [{ executor: "external-mcp" }] };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
}

export function NovelModelRoutingSettings() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Config>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Profile>();
  const [modalOpen, setModalOpen] = useState(false);
  const [probing, setProbing] = useState<string>();
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string; ownedBy?: string }[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const result = await request<{ config: Config }>("/v2/model-config");
      setConfig(result.config);
    } catch (error) { message.error(error instanceof Error ? error.message : "读取模型配置失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openProfile = (profile?: Profile) => {
    setEditing(profile);
    setModelOptions([]);
    form.setFieldsValue(profile ? {
      ...profile,
      secretMode: profile.secretSource ?? "inline",
      apiKey: "",
      envName: profile.secretSource === "env" ? profile.secretHint : "",
    } : { id: `prof-${crypto.randomUUID().slice(0, 8)}`, protocol: "chat-completions", responseMode: "sse", capabilities: ["text", "structured", "stream"], enabled: true, secretMode: "inline", timeoutMs: 1_800_000 });
    setModalOpen(true);
  };

  const saveProfile = async () => {
    const values = await form.validateFields();
    const next: Profile = {
      id: String(values.id).trim(), label: String(values.label).trim(), protocol: values.protocol,
      baseUrl: String(values.baseUrl).trim().replace(/\/+$/, ""), model: String(values.model).trim(),
      responseMode: values.protocol === "chat-completions" ? values.responseMode : "json",
      capabilities: values.capabilities, enabled: values.enabled !== false,
      timeoutMs: values.timeoutMs || undefined, contextWindow: values.contextWindow || undefined,
    };
    const enteredEnvName = values.secretMode === "env" && values.envName?.trim() ? String(values.envName).trim() : undefined;
    const enteredInlineKey = values.secretMode === "inline" && values.apiKey?.trim() ? String(values.apiKey).trim() : undefined;
    if (values.secretMode === "env") {
      // env 模式：以表单输入为准（环境变量名可改）；编辑时若未输入则保留原 hint
      if (enteredEnvName) next.secret = { source: "env", name: enteredEnvName };
      else if (editing?.secretSource === "env") next.secret = { source: "env", name: editing.secretHint ?? "" };
    } else {
      // inline 模式：仅在输入新 key 时覆盖；否则保留原 hasSecret/hint 元信息用于表格展示
      if (enteredInlineKey) next.secret = { source: "inline", value: enteredInlineKey };
    }
    // 编辑模式下保留原密钥元信息（用于本地表格"密钥"列显示，不会被持久化，后端会复用已存 secret）
    if (!next.secret && editing) {
      next.hasSecret = editing.hasSecret;
      next.secretSource = editing.secretSource;
      next.secretHint = editing.secretHint;
    }
    setConfig((current) => current ? { ...current, profiles: [...current.profiles.filter((profile) => profile.id !== editing?.id && profile.id !== next.id), next] } : current);
    setModalOpen(false);
  };

  const persist = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const clean: Config = {
        version: 1,
        profiles: config.profiles.map(({ hasSecret: _hasSecret, secretSource: _secretSource, secretHint: _secretHint, ...profile }) => profile),
        routes: config.routes,
      };
      const result = await request<{ config: Config }>("/v2/model-config", { method: "PUT", body: JSON.stringify({ config: clean }) });
      setConfig(result.config);
      message.success("小说模型路由已保存");
    } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
    finally { setSaving(false); }
  };

  const probe = async (profileId: string, capability: Capability) => {
    setProbing(`${profileId}:${capability}`);
    try {
      const result = await request<{ latencyMs: number; contract: Record<string, unknown> }>(`/v2/model-config/profiles/${encodeURIComponent(profileId)}/probe`, { method: "POST", body: JSON.stringify({ capability }) });
      const contract = Object.entries(result.contract).map(([key, value]) => `${key}=${String(value)}`).join("，");
      message.success(`${capability} 正常，${result.latencyMs} ms${contract ? `；${contract}` : ""}`);
    } catch (error) { message.error(error instanceof Error ? error.message : "连接失败"); }
    finally { setProbing(undefined); }
  };

  const fetchModels = async () => {
    const values = await form.getFieldsValue();
    const baseUrl = String(values.baseUrl ?? "").trim().replace(/\/+$/, "");
    const secretMode = values.secretMode ?? "inline";
    // 编辑已存在 profile 且密钥留空（保留原密钥）时，走 profileId 复用服务端已存密钥
    const useProfileId = Boolean(editing) && (secretMode === "inline" ? !values.apiKey?.trim() : !values.envName?.trim());
    if (!useProfileId && !baseUrl) { message.warning("请先填写 Base URL"); return; }
    setFetchingModels(true);
    try {
      const payload: Record<string, unknown> = useProfileId
        ? { profileId: editing!.id }
        : { baseUrl };
      if (!useProfileId) {
        if (secretMode === "inline" && values.apiKey?.trim()) payload.secret = { source: "inline", value: String(values.apiKey).trim() };
        else if (secretMode === "env" && values.envName?.trim()) payload.secret = { source: "env", name: String(values.envName).trim() };
      }
      const result = await request<{ models: { id: string; ownedBy?: string }[] }>("/v2/model-config/models", { method: "POST", body: JSON.stringify(payload) });
      const options = result.models.map((item) => ({ value: item.id, label: item.id, ownedBy: item.ownedBy }));
      setModelOptions(options);
      if (!options.length) message.warning("Base URL 返回的模型列表为空");
      else message.success(`已获取 ${options.length} 个模型`);
    } catch (error) { message.error(error instanceof Error ? error.message : "拉取模型列表失败"); }
    finally { setFetchingModels(false); }
  };

  if (!config && !loading) return <Alert type="error" showIcon message="无法读取 V2 模型路由配置" action={<Button onClick={() => void load()}>重试</Button>} />;

  return (
    <section style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid #27272a" }}>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }} align="start">
        <div>
          <Title level={3} style={{ margin: 0, fontSize: 20 }}>小说模型路由</Title>
          <Text type="secondary">V2 Runtime 全局 provider、purpose 路由与外部 MCP 执行策略</Text>
        </div>
        <Space>
          <Button icon={<PlusOutlined />} onClick={() => openProfile()}>添加接口</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void persist()}>保存路由</Button>
        </Space>
      </Space>

      <Table<Profile>
        rowKey="id" loading={loading} pagination={false} size="small" dataSource={config?.profiles ?? []}
        columns={[
          { title: "接口", dataIndex: "label", render: (_, profile) => <Space direction="vertical" size={0}><Text strong>{profile.label}</Text><Text type="secondary" style={{ fontSize: 12 }}>{profile.id}</Text></Space> },
          { title: "协议", dataIndex: "protocol", render: (value) => <Tag color={value === "responses" ? "blue" : "green"}>{value}</Tag> },
          { title: "模型", dataIndex: "model" },
          { title: "能力", dataIndex: "capabilities", render: (values: Capability[]) => <Space size={[4, 4]} wrap>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> },
          { title: "密钥", render: (_, profile) => <Text type={profile.hasSecret || profile.secret ? "success" : "warning"}>{profile.secretHint ?? (profile.secret ? "待保存" : "未配置")}</Text> },
          { title: "状态", dataIndex: "enabled", render: (value) => <Tag color={value ? "success" : "default"}>{value ? "启用" : "禁用"}</Tag> },
          { title: "操作", width: 142, render: (_, profile) => <Space>
            <Dropdown menu={{ items: profile.capabilities.map((capability) => ({ key: capability, label: `探测 ${capability}` })), onClick: ({ key }) => void probe(profile.id, key as Capability) }} trigger={["click"]}>
              <Tooltip title="按能力测试"><Button aria-label="按能力测试" icon={<ExperimentOutlined />} loading={probing?.startsWith(`${profile.id}:`)} /></Tooltip>
            </Dropdown>
            <Tooltip title="编辑"><Button aria-label="编辑" icon={<EditOutlined />} onClick={() => openProfile(profile)} /></Tooltip>
            <Popconfirm title="删除该接口？" onConfirm={() => setConfig((current) => current ? { ...current, profiles: current.profiles.filter((item) => item.id !== profile.id) } : current)}><Tooltip title="删除"><Button danger aria-label="删除" icon={<DeleteOutlined />} /></Tooltip></Popconfirm>
          </Space> },
        ]}
      />

      <div style={{ marginTop: 24 }}>
        <Title level={4} style={{ fontSize: 16 }}>调用位置</Title>
        <Table<Purpose>
          rowKey={(purpose) => purpose} pagination={false} size="small" dataSource={[...PURPOSES]}
          columns={[
            { title: "用途 / 角色", width: 220, render: (purpose: Purpose) => <Space direction="vertical" size={0}><Text strong>{PURPOSE_LABELS[purpose]}</Text><Text type="secondary" style={{ fontSize: 12 }}>{purpose}</Text></Space> },
            { title: "有序候选链", render: (purpose: Purpose) => {
              const route = inheritedRoute(config, purpose);
              const requiredCap = PURPOSE_CAPABILITY[purpose];
              const options = [
                ...(config?.profiles.filter((profile) => profile.enabled).map((profile) => {
                  const compatible = profile.capabilities.includes(requiredCap);
                  return { label: compatible ? profile.label : `${profile.label} (缺 ${requiredCap})`, value: `api:${profile.id}`, disabled: !compatible };
                }) ?? []),
                { label: "外部 MCP", value: "external-mcp" },
              ];
              const incompatibleIds = route.candidates
                .filter((c) => c.executor === "api")
                .map((c) => c.profileId)
                .filter((pid) => !config?.profiles.find((p) => p.id === pid)?.capabilities.includes(requiredCap));
              return (
                <CandidateChainEditor
                  value={route.candidates}
                  options={options}
                  incompatibleIds={incompatibleIds}
                  requiredCap={requiredCap}
                  onChange={(next) => setConfig((current) => current ? { ...current, routes: { ...current.routes, [purpose]: { ...route, candidates: next } } } : current)}
                />
              );
            } },
            { title: "上下文", width: 190, render: (purpose) => {
              const route = inheritedRoute(config, purpose);
              return purpose.startsWith("writing.") ? <Segmented size="small" value={route.conversationPolicy ?? "stateless"} options={[{ label: "无会话", value: "stateless" }, { label: "任务续接", value: "task-chain" }]} onChange={(value) => setConfig((current) => current ? { ...current, routes: { ...current.routes, [purpose]: { ...route, conversationPolicy: value as Route["conversationPolicy"] } } } : current)} /> : <Tag>隔离</Tag>;
            } },
          ]}
        />
      </div>

      <Modal title={editing ? "编辑模型接口" : "添加模型接口"} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => void saveProfile()} forceRender>
        <Form form={form} layout="vertical">
          <Form.Item name="id" label="Profile ID" rules={[{ required: true }]}><Input disabled prefix={<ApiOutlined />} /></Form.Item>
          <Form.Item name="label" label="显示名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="protocol" label="协议" rules={[{ required: true }]}><Segmented block options={[{ label: "Chat Completions", value: "chat-completions" }, { label: "Responses", value: "responses" }]} /></Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://api.example.com/v1" /></Form.Item>
          <Form.Item name="model" label="默认模型" rules={[{ required: true }]}>
            <AutoComplete
              style={{ width: "100%" }}
              placeholder={modelOptions.length ? "从列表选择或手动输入模型名" : "手动输入模型名，或点击右侧按钮拉取列表"}
              options={modelOptions}
              filterOption={(input, option) => (option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            >
              <Input
                suffix={
                  <Tooltip title="从 Base URL 拉取模型列表">
                    <Button type="text" size="small" aria-label="获取模型列表" icon={<ReloadOutlined />} loading={fetchingModels} onClick={() => void fetchModels()} />
                  </Tooltip>
                }
              />
            </AutoComplete>
          </Form.Item>
          <Form.Item name="responseMode" label="Chat 响应模式"><Segmented options={[{ label: "SSE", value: "sse" }, { label: "JSON", value: "json" }]} /></Form.Item>
          <Form.Item
            name="capabilities"
            label="能力"
            rules={[{ required: true }]}
            help="勾选该接口实际支持的能力。memory.embed / memory.rerank 等用途会按能力过滤候选,未勾选 embedding 的接口无法被选为对应用途的候选。"
          >
            <Select
              mode="multiple"
              options={[
                { label: "text 文本生成", value: "text" },
                { label: "structured 结构化输出", value: "structured" },
                { label: "stream 流式", value: "stream" },
                { label: "responses-continuation Responses 续接", value: "responses-continuation" },
                { label: "embedding 向量化", value: "embedding" },
                { label: "rerank 重排", value: "rerank" },
              ]}
            />
          </Form.Item>
          <Form.Item name="secretMode" label="密钥来源"><Segmented options={[{ label: "本地 Key", value: "inline" }, { label: "环境变量", value: "env" }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.secretMode !== after.secretMode}>{({ getFieldValue }) => getFieldValue("secretMode") === "env" ? <Form.Item name="envName" label="环境变量名"><Input placeholder="OPENAI_API_KEY" /></Form.Item> : <Form.Item name="apiKey" label="API Key" help={editing?.hasSecret ? "留空保留当前密钥" : undefined}><Input.Password /></Form.Item>}</Form.Item>
          <Space size="large">
            <Form.Item name="timeoutMs" label="超时毫秒"><InputNumber min={1000} step={1000} /></Form.Item>
            <Form.Item name="contextWindow" label="上下文上限"><InputNumber min={0} step={1000} /></Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </section>
  );
}

type CandidateOption = { label: string; value: string; disabled?: boolean };

function CandidateChainEditor({ value, options, incompatibleIds, requiredCap, onChange }: {
  value: Candidate[];
  options: CandidateOption[];
  incompatibleIds: string[];
  requiredCap: Capability;
  onChange: (next: Candidate[]) => void;
}) {
  const values = value.map(candidateValue);
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const remainingOptions = options.filter((o) => !values.includes(o.value) && !o.disabled);
  const setValues = (next: string[]) => onChange(next.map((candidate) => value.find((existing) => candidateValue(existing) === candidate) ?? fromCandidateValue(candidate)));

  return (
    <Space direction="vertical" size={4} style={{ width: "100%" }} align="start">
      {values.length > 0 && (
        <Reorder.Group
          axis="y"
          values={values}
          onReorder={setValues}
          style={{ listStyle: "none", padding: 0, margin: 0, width: "100%", display: "flex", flexDirection: "column", gap: 4 }}
        >
          {values.map((v) => {
            const isExternal = v === "external-mcp";
            const isBad = !isExternal && incompatibleIds.includes(v.slice(4));
            return (
              <Reorder.Item
                key={v}
                value={v}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", background: "#1f1f23", border: "1px solid #303034", borderRadius: 6, cursor: "grab", touchAction: "none" }}
                whileDrag={{ boxShadow: "0 4px 12px rgba(0,0,0,0.35)", borderColor: "#3f3f46" }}
              >
                <HolderOutlined style={{ color: "#888" }} />
                <Tag color={isExternal ? "default" : isBad ? "error" : "blue"} style={{ margin: 0, flex: 1 }}>{labelOf(v)}</Tag>
                <Tooltip title="移除">
                  <Button type="text" size="small" aria-label="移除候选" icon={<CloseOutlined />} onClick={() => setValues(values.filter((x) => x !== v))} />
                </Tooltip>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      )}
      <Select
        style={{ width: "100%" }}
        placeholder={remainingOptions.length ? "追加候选到链尾..." : "无更多候选可追加"}
        options={remainingOptions}
        value={null}
        showSearch
        onChange={(v) => { if (typeof v === "string") setValues([...values, v]); }}
        disabled={remainingOptions.length === 0}
      />
      {incompatibleIds.length > 0 && (
        <Text type="danger" style={{ fontSize: 12 }}>{`候选 ${incompatibleIds.join(", ")} 不支持 ${requiredCap}, 需移除或改选`}</Text>
      )}
    </Space>
  );
}
