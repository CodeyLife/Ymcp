import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Divider, Drawer, Empty, Form, Input, Modal, Select, Tag } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";

import { addEntity, appendOperation, novelDb, recordBase, updateEntity } from "./db";
import GenerationComposer from "./GenerationComposer";
import type { EntityKind, EntityRelation, StoryEntity } from "./types";

const KIND_LABEL: Record<EntityKind, string> = {
  character: "角色",
  location: "地点",
  organization: "组织",
  faction: "势力",
  item: "物品",
  species: "种族",
  rule: "规则",
  ability: "能力",
  term: "术语",
};

const KIND_COLOR: Record<EntityKind, string> = {
  character: "#1677ff",
  location: "#13c2c2",
  organization: "#722ed1",
  faction: "#eb2f96",
  item: "#fa8c16",
  species: "#52c41a",
  rule: "#f5222d",
  ability: "#2f54eb",
  term: "#8c8c8c",
};

const NON_CHARACTER_KINDS: EntityKind[] = [
  "location", "organization", "faction", "item", "species", "rule", "ability", "term",
];

const KIND_OPTIONS = NON_CHARACTER_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }));

const FILTER_OPTIONS = [
  { value: "all", label: "全部" },
  ...KIND_OPTIONS,
];

/**
 * 世界观设定库面板。
 *
 * 主从布局：左侧搜索+类型筛选+设定列表，右侧详情编辑+关联管理。
 * 替代原 WorldviewCanvasPanel，提供更适合结构化参考数据的增删改查体验。
 */
export function WorldviewLibraryPanel({ projectId }: { projectId: string }) {
  const { message, modal } = App.useApp();

  const entities = useLiveQuery(
    () => novelDb.entities.where("projectId").equals(projectId).and((item) => item.kind !== "character").toArray(),
    [projectId],
  ) ?? [];
  const relations = useLiveQuery(
    () => novelDb.relations.where("projectId").equals(projectId).toArray(),
    [projectId],
  ) ?? [];

  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [draft, setDraft] = useState<StoryEntity | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<EntityKind | "all">("all");
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [relationModalOpen, setRelationModalOpen] = useState(false);
  const [editingRelation, setEditingRelation] = useState<EntityRelation | null>(null);
  const [relationDraft, setRelationDraft] = useState<EntityRelation | null>(null);

  const selected = entities.find((item) => item.id === selectedId) ?? entities[0];

  useEffect(() => {
    setDraft(selected ? structuredClone(selected) : undefined);
  }, [selected]);

  useEffect(() => {
    if (editingRelation) setRelationDraft(structuredClone(editingRelation));
  }, [editingRelation]);

  const filteredEntities = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entities.filter((entity) => {
      if (kindFilter !== "all" && entity.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        entity.name.toLowerCase().includes(q) ||
        entity.summary.toLowerCase().includes(q) ||
        entity.aliases.some((a) => a.toLowerCase().includes(q))
      );
    });
  }, [entities, searchQuery, kindFilter]);

  const entityRelations = useMemo(() => {
    if (!draft) return [];
    return relations.filter((r) => r.fromEntityId === draft.id || r.toEntityId === draft.id);
  }, [relations, draft]);

  const entityOptions = useMemo(
    () => entities.map((e) => ({ value: e.id, label: `${e.name}（${KIND_LABEL[e.kind]}）` })),
    [entities],
  );

  const handleAddEntity = useCallback(
    async (kind: EntityKind) => {
      const entity = await addEntity(projectId, kind, `新${KIND_LABEL[kind]}`);
      setSelectedId(entity.id);
    },
    [projectId],
  );

  const handleSaveEntity = useCallback(async () => {
    if (!draft) return;
    await updateEntity(draft);
    message.success("设定已保存");
  }, [draft, message]);

  const handleDeleteEntity = useCallback(
    async (entityId: string) => {
      const related = relations.filter((r) => r.fromEntityId === entityId || r.toEntityId === entityId);
      await novelDb.transaction("rw", novelDb.entities, novelDb.relations, novelDb.operations, async () => {
        for (const r of related) {
          await novelDb.relations.delete(r.id);
          await appendOperation(projectId, "relations", r.id, "delete", { value: { before: r, after: null } });
        }
        const entity = await novelDb.entities.get(entityId);
        await novelDb.entities.delete(entityId);
        await appendOperation(projectId, "entities", entityId, "delete", { name: { before: entity?.name ?? null, after: null } });
      });
      message.success("设定已删除");
      if (selectedId === entityId) setSelectedId(undefined);
    },
    [projectId, relations, message, selectedId],
  );

  const handleCreateRelation = useCallback(
    async (fromEntityId: string, toEntityId: string) => {
      const relation: EntityRelation = {
        ...recordBase(projectId),
        fromEntityId,
        toEntityId,
        relationType: "关联",
        publicLabel: "",
        privateTruth: "",
        bond: "",
        history: [],
      };
      await novelDb.relations.add(relation);
      await appendOperation(projectId, "relations", relation.id, "create", {
        relationType: { before: null, after: relation.relationType },
      });
      setEditingRelation(relation);
    },
    [projectId],
  );

  const handleSaveRelation = useCallback(async () => {
    if (!relationDraft) return;
    const before = await novelDb.relations.get(relationDraft.id);
    await novelDb.relations.put({ ...relationDraft, revision: (before?.revision ?? 0) + 1, updatedAt: Date.now() });
    await appendOperation(projectId, "relations", relationDraft.id, before ? "update" : "create", {
      value: { before, after: relationDraft },
    });
    setEditingRelation(null);
    setRelationDraft(null);
    message.success("关联已保存");
  }, [projectId, relationDraft, message]);

  const handleDeleteRelation = useCallback(
    async (relationId: string) => {
      const relation = await novelDb.relations.get(relationId);
      await novelDb.relations.delete(relationId);
      await appendOperation(projectId, "relations", relationId, "delete", { value: { before: relation, after: null } });
      message.success("关联已删除");
    },
    [projectId, message],
  );

  const confirmDeleteEntity = useCallback(
    (entityId: string, name: string) => {
      modal.confirm({
        title: `删除"${name}"？`,
        content: "该设定及其所有关联将一并删除。",
        okButtonProps: { danger: true },
        onOk: () => handleDeleteEntity(entityId),
      });
    },
    [modal, handleDeleteEntity],
  );

  return (
    <div className="novel-view-content">
      <GenerationComposer projectId={projectId} scope="worldview" taskKeys={["worldview"]} compact getRefinementSnapshot={() => ({ entities: draft ? [draft as unknown as Record<string, unknown>] : [], relations: relationDraft ? [relationDraft as unknown as Record<string, unknown>] : [] })} />
      <header className="novel-section-title">
        <div>
          <span>WORLDVIEW</span>
          <h2>世界观设定</h2>
          <p>地点、组织、势力、物品等设定要素的增删改查与关联管理。</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>添加设定</Button>
      </header>

      {entities.length === 0 ? (
        <div className="novel-empty-panel">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>还没有设定</strong><span>创建地点、组织、物品等世界观要素。</span></>} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>创建第一个设定</Button>
        </div>
      ) : (
        <div className="novel-worldview-layout">
          <aside className="novel-worldview-sidebar">
            <Input.Search
              placeholder="搜索设定..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              allowClear
              size="small"
            />
            <Select
              size="small"
              value={kindFilter}
              onChange={(v) => setKindFilter(v as EntityKind | "all")}
              options={FILTER_OPTIONS}
              style={{ width: "100%" }}
            />
            <div className="novel-worldview-list">
              {filteredEntities.map((entity) => (
                <button
                  key={entity.id}
                  className={selected?.id === entity.id ? "active" : ""}
                  onClick={() => setSelectedId(entity.id)}
                >
                  <span style={{ background: `${KIND_COLOR[entity.kind]}22`, color: KIND_COLOR[entity.kind] }}>
                    {KIND_LABEL[entity.kind].slice(0, 1)}
                  </span>
                  <div>
                    <strong>{entity.name}</strong>
                    <small>{KIND_LABEL[entity.kind]}</small>
                  </div>
                </button>
              ))}
              {filteredEntities.length === 0 && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配设定" />
              )}
            </div>
          </aside>

          {draft ? (
            <main className="novel-worldview-detail">
              <div className="novel-worldview-identity">
                <span style={{ background: KIND_COLOR[draft.kind] }}>{draft.name.slice(0, 1) || "设"}</span>
                <div>
                  <Input
                    variant="borderless"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="设定名称"
                  />
                  <Select
                    variant="borderless"
                    value={draft.kind}
                    options={KIND_OPTIONS}
                    onChange={(kind: EntityKind) => setDraft({ ...draft, kind })}
                    style={{ width: "fit-content" }}
                  />
                </div>
                <Button type="primary" icon={<SaveOutlined />} onClick={() => void handleSaveEntity()}>保存</Button>
                <Button danger icon={<DeleteOutlined />} onClick={() => confirmDeleteEntity(draft.id, draft.name)} />
              </div>

              <div className="novel-form-grid">
                <label>摘要<Input.TextArea rows={2} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
                <label>别名<Input value={draft.aliases.join("、")} placeholder="逗号分隔" onChange={(e) => setDraft({ ...draft, aliases: e.target.value.split(/[、,，]/).filter(Boolean) })} /></label>
              </div>
              <label className="novel-worldview-full-row">详细描述<Input.TextArea rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
              <label className="novel-worldview-full-row">标签<Input value={draft.tags.join("、")} placeholder="逗号分隔" onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(/[、,，]/).filter(Boolean) })} /></label>
              {draft.tags.length > 0 && (
                <div className="novel-worldview-tags">{draft.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
              )}

              <div className="novel-worldview-locked-facts">
                <header>
                  <strong>锁定事实</strong>
                  <Button type="text" size="small" icon={<PlusOutlined />} onClick={() => setDraft({ ...draft, lockedFacts: [...draft.lockedFacts, ""] })}>添加</Button>
                </header>
                {draft.lockedFacts.map((fact, i) => (
                  <div key={i}>
                    <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} value={fact} onChange={(e) => {
                      const next = [...draft.lockedFacts];
                      next[i] = e.target.value;
                      setDraft({ ...draft, lockedFacts: next });
                    }} />
                    <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDraft({ ...draft, lockedFacts: draft.lockedFacts.filter((_, idx) => idx !== i) })} />
                  </div>
                ))}
              </div>

              <div className="novel-worldview-attributes">
                <header>
                  <strong>自定义属性</strong>
                  <Button type="text" size="small" icon={<PlusOutlined />} onClick={() => {
                    const key = `属性${Object.keys(draft.attributes).length + 1}`;
                    setDraft({ ...draft, attributes: { ...draft.attributes, [key]: "" } });
                  }}>添加</Button>
                </header>
                {Object.entries(draft.attributes).map(([key, value]) => (
                  <div key={key}>
                    <Input value={key} onChange={(e) => {
                      const next = { ...draft.attributes };
                      const v = next[key];
                      delete next[key];
                      next[e.target.value] = v;
                      setDraft({ ...draft, attributes: next });
                    }} />
                    <Input value={String(value)} onChange={(e) => setDraft({ ...draft, attributes: { ...draft.attributes, [key]: e.target.value } })} />
                    <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => {
                      const next = { ...draft.attributes };
                      delete next[key];
                      setDraft({ ...draft, attributes: next });
                    }} />
                  </div>
                ))}
              </div>

              <Divider>关联关系</Divider>
              <div className="novel-worldview-relations">
                <header>
                  <strong>涉及关联</strong>
                  <Button size="small" icon={<PlusOutlined />} disabled={entities.length < 2} onClick={() => setRelationModalOpen(true)}>添加关联</Button>
                </header>
                {entityRelations.map((relation) => {
                  const otherId = relation.fromEntityId === draft.id ? relation.toEntityId : relation.fromEntityId;
                  const otherEntity = entities.find((e) => e.id === otherId);
                  return (
                    <article key={relation.id}>
                      <div className="novel-worldview-relation-head">
                        <Tag color={KIND_COLOR[otherEntity?.kind ?? "term"]}>{relation.relationType}</Tag>
                        <strong>{otherEntity?.name ?? "未知设定"}</strong>
                        {relation.publicLabel && <small>{relation.publicLabel}</small>}
                      </div>
                      {relation.bond && <p className="novel-worldview-relation-bond">{relation.bond}</p>}
                      {relation.privateTruth && <blockquote className="novel-worldview-truth">{relation.privateTruth}</blockquote>}
                      <div className="novel-worldview-relation-actions">
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditingRelation(relation)}>编辑</Button>
                        <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => void handleDeleteRelation(relation.id)}>删除</Button>
                      </div>
                    </article>
                  );
                })}
                {entityRelations.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无关联" />}
              </div>
            </main>
          ) : (
            <div className="novel-empty-panel">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>选择一个设定</strong><span>从左侧选择或创建新的设定。</span></>} />
            </div>
          )}
        </div>
      )}

      <Drawer
        title="编辑关联"
        open={!!editingRelation}
        onClose={() => { setEditingRelation(null); setRelationDraft(null); }}
        width={460}
        extra={<Button type="primary" icon={<SaveOutlined />} onClick={() => void handleSaveRelation()}>保存</Button>}
      >
        {relationDraft && (
          <Form layout="vertical" className="flex flex-col gap-3">
            <Form.Item label="起始设定">
              <Select value={relationDraft.fromEntityId} options={entityOptions} onChange={(fromEntityId) => setRelationDraft({ ...relationDraft, fromEntityId })} />
            </Form.Item>
            <Form.Item label="目标设定">
              <Select value={relationDraft.toEntityId} options={entityOptions} onChange={(toEntityId) => setRelationDraft({ ...relationDraft, toEntityId })} />
            </Form.Item>
            <Form.Item label="关联类型">
              <Input value={relationDraft.relationType} onChange={(e) => setRelationDraft({ ...relationDraft, relationType: e.target.value })} />
            </Form.Item>
            <Form.Item label="公开描述">
              <Input.TextArea rows={2} value={relationDraft.publicLabel} onChange={(e) => setRelationDraft({ ...relationDraft, publicLabel: e.target.value })} />
            </Form.Item>
            <Form.Item label="未公开真相">
              <Input.TextArea rows={2} value={relationDraft.privateTruth} onChange={(e) => setRelationDraft({ ...relationDraft, privateTruth: e.target.value })} />
            </Form.Item>
            <Form.Item label="关系羁绊">
              <Input.TextArea rows={3} value={relationDraft.bond} placeholder="用中文描述两人的关系状态，如：关系亲密，已建立信任，近期因误会产生隔阂" onChange={(e) => setRelationDraft({ ...relationDraft, bond: e.target.value })} />
            </Form.Item>
          </Form>
        )}
      </Drawer>

      <AddEntityModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onCreate={async (kind) => {
          await handleAddEntity(kind);
          setAddModalOpen(false);
        }}
      />

      <CreateRelationModal
        open={relationModalOpen}
        entities={entities}
        onClose={() => setRelationModalOpen(false)}
        onCreate={async (fromId, toId) => {
          await handleCreateRelation(fromId, toId);
          setRelationModalOpen(false);
        }}
      />
    </div>
  );
}

function AddEntityModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (kind: EntityKind) => void | Promise<void>;
}) {
  const [form] = Form.useForm<{ kind: EntityKind }>();
  return (
    <Modal
      title="添加设定"
      open={open}
      onCancel={() => { form.resetFields(); onClose(); }}
      onOk={async () => {
        const values = await form.validateFields();
        await onCreate(values.kind);
        form.resetFields();
      }}
      okText="创建"
      cancelText="取消"
    >
      <Form form={form} layout="vertical" initialValues={{ kind: "location" }}>
        <Form.Item name="kind" label="类型" rules={[{ required: true, message: "请选择类型" }]}>
          <Select options={KIND_OPTIONS} placeholder="选择设定类型" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function CreateRelationModal({
  open,
  entities,
  onClose,
  onCreate,
}: {
  open: boolean;
  entities: StoryEntity[];
  onClose: () => void;
  onCreate: (fromId: string, toId: string) => void | Promise<void>;
}) {
  const [form] = Form.useForm<{ fromEntityId: string; toEntityId: string }>();
  const options = useMemo(
    () => entities.map((e) => ({ value: e.id, label: `${e.name}（${KIND_LABEL[e.kind]}）` })),
    [entities],
  );
  return (
    <Modal
      title="建立关联"
      open={open}
      onCancel={() => { form.resetFields(); onClose(); }}
      onOk={async () => {
        const values = await form.validateFields();
        await onCreate(values.fromEntityId, values.toEntityId);
        form.resetFields();
      }}
      okText="创建"
      cancelText="取消"
    >
      <Form form={form} layout="vertical">
        <Form.Item name="fromEntityId" label="起始设定" rules={[{ required: true, message: "请选择设定" }]}>
          <Select options={options} placeholder="选择设定" />
        </Form.Item>
        <Form.Item name="toEntityId" label="目标设定" rules={[{ required: true, message: "请选择设定" }]}>
          <Select options={options} placeholder="选择设定" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
