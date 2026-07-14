import { EnvironmentOutlined } from "@ant-design/icons";

import type { StoryEntity } from "../types";

/**
 * 角色节点内容：渲染在 CanvasNodeShell 内部的人物卡片。
 *
 * 纯展示组件，不持有状态。展示角色头像（首字）、姓名、身份、摘要/情绪、当前位置。
 * 节点尺寸由 CanvasNodeShell 的 width/height 控制，内容自适应填充。
 */
export function CharacterNodeContent({ entity }: { entity: StoryEntity }) {
  const initial = entity.name.slice(0, 1) || "?";
  const role = entity.character?.role || "角色";
  const state = entity.character?.state;
  const summary = entity.summary || state?.emotional || "尚未设定";

  return (
    <div className="flex h-full flex-col gap-2 p-3" data-character-node={entity.id}>
      <div className="flex items-center gap-2">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-base font-bold"
          style={{ background: "rgba(255,255,255,0.10)" }}
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{entity.name}</div>
          <div className="truncate text-xs opacity-60">{role}</div>
        </div>
      </div>
      <p className="line-clamp-3 flex-1 overflow-hidden text-xs leading-relaxed opacity-70">{summary}</p>
      {state?.location && (
        <div className="flex items-center gap-1 text-xs opacity-50">
          <EnvironmentOutlined />
          <span className="truncate">{state.location}</span>
        </div>
      )}
    </div>
  );
}
