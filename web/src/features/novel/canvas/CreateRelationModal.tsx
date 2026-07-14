import { useMemo } from "react";
import { Form, Modal, Select } from "antd";

import type { StoryEntity } from "../types";

export interface CreateRelationModalProps {
  open: boolean;
  entities: StoryEntity[];
  onClose: () => void;
  onCreate: (fromId: string, toId: string) => void | Promise<void>;
}

export default function CreateRelationModal({
  open,
  entities,
  onClose,
  onCreate,
}: CreateRelationModalProps) {
  const [form] = Form.useForm<{ fromEntityId: string; toEntityId: string }>();
  const options = useMemo(() => entities.map((e) => ({ value: e.id, label: e.name })), [entities]);

  return (
    <Modal
      title="建立关系"
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
        <Form.Item name="fromEntityId" label="起始角色" rules={[{ required: true, message: "请选择角色" }]}>
          <Select options={options} placeholder="选择角色" />
        </Form.Item>
        <Form.Item name="toEntityId" label="目标角色" rules={[{ required: true, message: "请选择角色" }]}>
          <Select options={options} placeholder="选择角色" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
