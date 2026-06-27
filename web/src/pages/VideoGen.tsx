import { Card, Result } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import { PageHeader } from "@/components/showtime";
import { motion } from "motion/react";

export default function VideoGen() {
  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="视频生成"
        description="接口已预留，等待接入 Seedance 2.0 / Kling API。"
        icon={<VideoCameraOutlined />}
      />
      <Card style={{ background: "#18181b", borderColor: "#27272a" }}>
        <Result
          icon={
            <motion.span
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              style={{ display: "inline-block" }}
            >
              <VideoCameraOutlined
                style={{
                  color: "#34d399",
                  filter: "drop-shadow(0 0 16px rgba(52, 211, 153, 0.45))",
                }}
              />
            </motion.span>
          }
          title={<span style={{ color: "#f4f4f5" }}>即将推出</span>}
          subTitle={
            <span style={{ color: "#71717a" }}>
              计划支持文生视频与图生视频，通过火山方舟或 Kling API 实现。
            </span>
          }
        />
      </Card>
    </div>
  );
}
