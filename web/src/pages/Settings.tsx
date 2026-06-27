import { Card, Typography, Form, Input, InputNumber, Button, Divider, App, Alert } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import { useUIStore, getEffectiveApiConfig } from "@/stores/ui";
import { PageHeader } from "@/components/showtime";

const { Text } = Typography;
const { TextArea } = Input;

export default function Settings() {
  const { message } = App.useApp();
  const apiBaseUrl = useUIStore((s) => s.apiBaseUrl);
  const apiKey = useUIStore((s) => s.apiKey);
  const thumbSize = useUIStore((s) => s.thumbSize);
  const greenscreenPrompt = useUIStore((s) => s.greenscreenPrompt);
  const spritesheetPrompt = useUIStore((s) => s.spritesheetPrompt);
  const setApiConfig = useUIStore((s) => s.setApiConfig);
  const setThumbSize = useUIStore((s) => s.setThumbSize);
  const setGreenscreenPrompt = useUIStore((s) => s.setGreenscreenPrompt);
  const setSpritesheetPrompt = useUIStore((s) => s.setSpritesheetPrompt);
  const { hasOwnKey } = getEffectiveApiConfig();

  function onSave(values: {
    base_url: string;
    api_key: string;
    thumb_size: number;
    greenscreen_prompt: string;
    spritesheet_prompt: string;
  }) {
    setApiConfig(values.base_url || "", values.api_key || "");
    setThumbSize(values.thumb_size || 256);
    setGreenscreenPrompt(values.greenscreen_prompt || "");
    setSpritesheetPrompt(values.spritesheet_prompt || "");
    message.success("设置已保存");
  }

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="设置"
        description="AI 接口配置与提示词模板。所有设置自动持久化到本地，刷新不丢失。"
        icon={<SettingOutlined />}
      />

      <Card style={{ background: "#18181b", borderColor: "#27272a", maxWidth: 640 }} styles={{ body: { padding: 20 } }}>
        {!hasOwnKey && (
          <Alert
            type="info"
            showIcon
            message="当前使用默认接口，生图数量限制为 1。配置自有 Key 后可解锁完整功能。"
            style={{ marginBottom: 16 }}
          />
        )}
        <Form
          layout="vertical"
          initialValues={{
            base_url: apiBaseUrl,
            api_key: apiKey,
            thumb_size: thumbSize,
            greenscreen_prompt: greenscreenPrompt,
            spritesheet_prompt: spritesheetPrompt,
          }}
          onFinish={onSave}
        >
          <Form.Item label="Base URL" name="base_url" help={apiBaseUrl ? "使用自有接口" : "留空使用默认接口"}>
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item label="API Key" name="api_key" help={apiKey ? "使用自有 Key" : "留空使用默认 Key（不显示）"}>
            <Input.Password placeholder="sk-..." />
          </Form.Item>
          <Divider style={{ borderColor: "#27272a" }} />
          <Form.Item label="缩略图尺寸" name="thumb_size" help="素材库和历史记录的缩略图尺寸">
            <InputNumber min={64} max={512} style={{ width: "100%" }} />
          </Form.Item>
          <Divider style={{ borderColor: "#27272a" }} />
          <Form.Item
            label="绿幕模式提示词"
            name="greenscreen_prompt"
            help="生成时自动插入到用户提示词前，要求纯绿背景无光影"
          >
            <TextArea rows={3} style={{ resize: "vertical" }} />
          </Form.Item>
          <Form.Item
            label="序列帧模式提示词"
            name="spritesheet_prompt"
            help="生成时自动插入到用户提示词前，要求输出 NxN 网格序列帧图集"
          >
            <TextArea rows={4} style={{ resize: "vertical" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            保存
          </Button>
          {hasOwnKey && (
            <Text style={{ color: "#10b981", fontSize: 12, marginLeft: 12 }}>
              已配置自有接口
            </Text>
          )}
        </Form>
      </Card>
    </div>
  );
}
