import { Card, Typography, Form, Input, InputNumber, Button, Divider, App, Alert, Segmented } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import { useUIStore, getEffectiveApiConfig, type ImageGenAdapter } from "@/stores/ui";
import { DEFAULT_GREENSCREEN_PROMPT, DEFAULT_SPRITESHEET_PROMPT } from "@/config/defaults";
import { PageHeader } from "@/components/showtime";
import { ChatModelSelect } from "@/components/ChatModelSelect";

const { Text } = Typography;
const { TextArea } = Input;

export default function Settings() {
  const { message } = App.useApp();
  const apiBaseUrl = useUIStore((s) => s.apiBaseUrl);
  const apiKey = useUIStore((s) => s.apiKey);
  const chatModel = useUIStore((s) => s.chatModel);
  const modelContextWindow = useUIStore((s) => s.modelContextWindow);
  const thumbSize = useUIStore((s) => s.thumbSize);
  const greenscreenPrompt = useUIStore((s) => s.greenscreenPrompt);
  const spritesheetPrompt = useUIStore((s) => s.spritesheetPrompt);
  const imageGenAdapter = useUIStore((s) => s.imageGenAdapter);
  const setApiBaseUrl = useUIStore((s) => s.setApiBaseUrl);
  const setApiKey = useUIStore((s) => s.setApiKey);
  const setChatModel = useUIStore((s) => s.setChatModel);
  const setModelContextWindow = useUIStore((s) => s.setModelContextWindow);
  const setThumbSize = useUIStore((s) => s.setThumbSize);
  const setGreenscreenPrompt = useUIStore((s) => s.setGreenscreenPrompt);
  const setSpritesheetPrompt = useUIStore((s) => s.setSpritesheetPrompt);
  const setImageGenAdapter = useUIStore((s) => s.setImageGenAdapter);
  const { hasOwnKey, usesDefaultBaseUrl } = getEffectiveApiConfig();

  function onSave(values: {
    api_base_url: string;
    api_key: string;
    chat_model: string;
    model_context_window: number;
    thumb_size: number;
    greenscreen_prompt: string;
    spritesheet_prompt: string;
  }) {
    setApiBaseUrl(values.api_base_url || "");
    setApiKey(values.api_key || "");
    setChatModel(values.chat_model || "gpt-5-5");
    setModelContextWindow(values.model_context_window || 0);
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
        {!hasOwnKey && usesDefaultBaseUrl && (
          <Alert
            type="info"
            showIcon
            message="当前使用默认接口，生图数量限制为 1。配置自有 Key 后可解锁完整功能。"
            style={{ marginBottom: 16 }}
          />
        )}
        {!hasOwnKey && !usesDefaultBaseUrl && (
          <Alert
            type="warning"
            showIcon
            message="当前使用自定义接口地址，请填写该接口对应的 API Key。"
            style={{ marginBottom: 16 }}
          />
        )}
        <Form
          layout="vertical"
          initialValues={{
            api_base_url: apiBaseUrl,
            api_key: apiKey,
            chat_model: chatModel,
            model_context_window: modelContextWindow,
            thumb_size: thumbSize,
            greenscreen_prompt: greenscreenPrompt,
            spritesheet_prompt: spritesheetPrompt,
          }}
          onFinish={onSave}
        >
          <Form.Item label="API Base URL" name="api_base_url" help="留空使用默认接口地址">
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item label="API Key" name="api_key" help={apiKey ? "使用自有 Key" : "留空使用默认 Key（不显示）"}>
            <Input.Password placeholder="sk-..." />
          </Form.Item>
          <Form.Item label="对话模型" name="chat_model" help="新配置默认 gpt-5-5；仍可选择 auto 由接口自动选择可用模型">
            <ChatModelSelect style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="模型上下文硬上限" name="model_context_window" help="留空或 0 时读取 /models 返回的能力字段；自定义接口未返回时可手动填写，例如 128000">
            <InputNumber min={0} step={1000} precision={0} style={{ width: "100%" }} placeholder="自动检测" addonAfter="tokens" />
          </Form.Item>
          <Divider style={{ borderColor: "#27272a" }} />
          <Form.Item
            label="生图调用模式"
            help="任务模式：走后端异步任务接口，支持断线恢复；直连模式：标准 OpenAI 兼容 /images/generations 接口，不支持后台恢复"
          >
            <Segmented
              block
              value={imageGenAdapter}
              onChange={(v) => setImageGenAdapter(v as ImageGenAdapter)}
              options={[
                { label: "任务模式", value: "task" },
                { label: "直连模式", value: "direct" },
              ]}
            />
          </Form.Item>
          <Divider style={{ borderColor: "#27272a" }} />
          <Form.Item label="缩略图尺寸" name="thumb_size" help="素材库和历史记录的缩略图尺寸">
            <InputNumber min={64} max={512} style={{ width: "100%" }} />
          </Form.Item>
          <Divider style={{ borderColor: "#27272a" }} />
          <Form.Item
            label="绿幕模式提示词"
            name="greenscreen_prompt"
            help="留空使用默认配置。生成时自动插入到用户提示词前，要求纯绿背景无光影"
          >
            <TextArea
              rows={3}
              style={{ resize: "vertical" }}
              placeholder={DEFAULT_GREENSCREEN_PROMPT}
            />
          </Form.Item>
          <Form.Item
            label="序列帧模式提示词"
            name="spritesheet_prompt"
            help="留空使用默认配置。生成时自动插入到用户提示词前，要求输出 NxN 网格序列帧图集"
          >
            <TextArea
              rows={4}
              style={{ resize: "vertical" }}
              placeholder={DEFAULT_SPRITESHEET_PROMPT}
            />
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
