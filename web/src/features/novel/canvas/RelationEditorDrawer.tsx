import { Button, Drawer, Input, Select } from "antd";
import { SaveOutlined } from "@ant-design/icons";

import type { EntityRelation, StoryEntity } from "../types";

export interface RelationEditorDrawerProps {
  relation: EntityRelation | null;
  draft: EntityRelation | null;
  entities: StoryEntity[];
  onDraftChange: (next: EntityRelation) => void;
  onSave: () => void;
  onClose: () => void;
}

export default function RelationEditorDrawer({
  relation,
  draft,
  entities,
  onDraftChange,
  onSave,
  onClose,
}: RelationEditorDrawerProps) {
  const entityOptions = entities.map((e) => ({ value: e.id, label: e.name }));

  return (
    <Drawer
      title="编辑关系"
      open={!!relation}
      onClose={onClose}
      width={460}
      extra={<Button type="primary" icon={<SaveOutlined />} onClick={onSave}>保存</Button>}
    >
      {draft && (
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <Select
              value={draft.fromEntityId}
              options={entityOptions}
              onChange={(fromEntityId) => onDraftChange({ ...draft, fromEntityId })}
              className="flex-1"
            />
            <span className="flex items-center">→</span>
            <Select
              value={draft.toEntityId}
              options={entityOptions}
              onChange={(toEntityId) => onDraftChange({ ...draft, toEntityId })}
              className="flex-1"
            />
          </div>
          <Input
            addonBefore="关系类型"
            value={draft.relationType}
            onChange={(event) => onDraftChange({ ...draft, relationType: event.target.value })}
          />
          <Input.TextArea
            rows={2}
            value={draft.publicLabel}
            placeholder="其他人眼中的关系"
            onChange={(event) => onDraftChange({ ...draft, publicLabel: event.target.value })}
          />
          <Input.TextArea
            rows={2}
            value={draft.privateTruth}
            placeholder="关系双方未公开的真相"
            onChange={(event) => onDraftChange({ ...draft, privateTruth: event.target.value })}
          />
          <div>
            <div className="mb-1 text-sm">关系羁绊</div>
            <Input.TextArea
              rows={3}
              value={draft.bond}
              placeholder="用中文描述两人的关系状态，如：关系亲密，已建立信任，近期因误会产生隔阂"
              onChange={(event) => onDraftChange({ ...draft, bond: event.target.value })}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
}
