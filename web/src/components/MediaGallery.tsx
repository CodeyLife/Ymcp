"use client";

/**
 * MediaGallery - 素材库 / 历史记录共享的图片画廊
 *
 * 设计语言：
 * - 卡片以图片满铺为背景（object-fit: cover）
 * - 底部叠加深色半透明渐变区，承载标题、元数据、操作按钮
 * - 顶部左侧复选框用于单选，顶部右侧徽章标识来源/模式
 * - 多图卡片支持左右切换
 *
 * 选择模型：
 * - 单选：点击卡片左上角复选框
 * - 整页选：工具栏「全选本页」复选框（含 indeterminate 态）
 * - 全选：工具栏「选择全部」链接，跨所有分页
 *
 * 删除：工具栏「删除选中」按钮，批量删除所有选中项
 */

import { useState, useMemo, useCallback, useEffect, type ReactNode } from "react";
import { Checkbox, Button, Popconfirm, Tooltip, Pagination } from "antd";
import {
  DeleteOutlined, DownloadOutlined, ScissorOutlined, ReloadOutlined,
  LeftOutlined, RightOutlined, PictureOutlined,
  StarOutlined, StarFilled,
} from "@ant-design/icons";
import { motion } from "motion/react";
import { useMotionMode } from "@/hooks/useMotionMode";
import { useImageUrl } from "@/hooks/useImageUrl";
import { EmptyState } from "./showtime";

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface MediaBadge {
  label: string;
  color: "emerald" | "blue" | "orange" | "violet";
}

export interface MediaMeta {
  label: string;
  value: string;
}

export interface MediaItem {
  id: string;
  /** 图片引用 id 数组（指向 IndexedDB 中的 Blob），单图卡片仅 1 项；多图支持左右切换 */
  imageIds: string[];
  title: string;
  metas: MediaMeta[];
  badge?: MediaBadge;
  /** 是否已收藏（由消费方从素材库派生） */
  favorited?: boolean;
  /** 原始数据，供消费方在回调中取用（如复用参数） */
  raw?: unknown;
}

export interface MediaGalleryProps {
  items: MediaItem[];
  emptyIcon?: ReactNode;
  emptyTitle: string;
  emptyDescription?: string;
  onPreview?: (imageId: string, item: MediaItem) => void;
  onDownload?: (imageId: string, item: MediaItem) => void;
  onMatte?: (imageId: string, item: MediaItem) => void;
  onReuse?: (item: MediaItem) => void;
  /** 收藏/取消收藏回调，传入时卡片渲染星标按钮 */
  onFavorite?: (item: MediaItem) => void;
  onDelete: (ids: string[]) => void;
  pageSize?: number;
}

/* ============================================================
 * 徽章配色（与现有 emerald 主色一致，扩展辅色用于来源区分）
 * ============================================================ */

const BADGE_STYLES: Record<MediaBadge["color"], { bg: string; border: string; color: string }> = {
  emerald: { bg: "rgba(16, 185, 129, 0.22)",  border: "rgba(16, 185, 129, 0.45)",  color: "#34d399" },
  blue:    { bg: "rgba(59, 130, 246, 0.22)",  border: "rgba(59, 130, 246, 0.45)",  color: "#60a5fa" },
  orange:  { bg: "rgba(249, 115, 22, 0.22)",  border: "rgba(249, 115, 22, 0.45)",  color: "#fb923c" },
  violet:  { bg: "rgba(139, 92, 246, 0.22)",  border: "rgba(139, 92, 246, 0.45)",  color: "#a78bfa" },
};

/* ============================================================
 * MediaCard - 单张图片卡片
 * ============================================================ */

interface MediaCardProps {
  item: MediaItem;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onPreview?: (imageId: string, item: MediaItem) => void;
  onDownload?: (imageId: string, item: MediaItem) => void;
  onMatte?: (imageId: string, item: MediaItem) => void;
  onReuse?: (item: MediaItem) => void;
  onFavorite?: (item: MediaItem) => void;
}

function MediaCard({
  item, selected, onToggleSelect, onPreview, onDownload, onMatte, onReuse, onFavorite,
}: MediaCardProps) {
  const reduce = useMotionMode();
  const [imgIdx, setImgIdx] = useState(0);
  const total = item.imageIds.length;
  const currentId = item.imageIds[imgIdx];
  const current = useImageUrl(currentId);
  const badgeStyle = item.badge ? BADGE_STYLES[item.badge.color] : null;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 16, scale: 0.96 },
        show: {
          opacity: 1, y: 0, scale: 1,
          transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] as const },
        },
      }}
      whileHover={reduce ? undefined : { y: -4, transition: { duration: 0.22 } }}
      onClick={() => currentId && onPreview?.(currentId, item)}
      style={{
        position: "relative",
        aspectRatio: "3 / 4",
        borderRadius: 10,
        overflow: "hidden",
        cursor: currentId ? "pointer" : "default",
        border: selected
          ? "2px solid #34d399"
          : "1px solid #27272a",
        boxShadow: selected
          ? "0 0 0 1px rgba(52, 211, 153, 0.35), 0 10px 28px rgba(16, 185, 129, 0.2)"
          : "0 4px 14px rgba(0, 0, 0, 0.22)",
        background: "#0c0c0f",
        transition: "border-color 0.2s ease, box-shadow 0.2s ease",
        userSelect: "none",
      }}
    >
      {/* 全铺背景图 */}
      {current ? (
        <img
          src={current}
          alt={item.title}
          loading="lazy"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transition: "transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: "#3f3f46",
            fontSize: 36,
          }}
        >
          {currentId ? <PictureOutlined spin /> : <PictureOutlined />}
        </div>
      )}

      {/* 选中态边框内高光 */}
      {selected && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "inherit",
            boxShadow: "inset 0 0 0 1px rgba(52, 211, 153, 0.25)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
      )}

      {/* 左上：选择复选框 */}
      <div
        onClick={(e) => { e.stopPropagation(); onToggleSelect(item.id); }}
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 3,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: 6,
          background: selected
            ? "rgba(16, 185, 129, 0.9)"
            : "rgba(0, 0, 0, 0.55)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          border: selected
            ? "1px solid rgba(52, 211, 153, 0.9)"
            : "1px solid rgba(255, 255, 255, 0.2)",
          cursor: "pointer",
          transition: "all 0.18s ease",
        }}
        role="checkbox"
        aria-checked={selected}
      >
        <Checkbox checked={selected} style={{ opacity: 0, margin: 0, padding: 0 }} />
        {selected && (
          <svg
            viewBox="0 0 12 12"
            width={12}
            height={12}
            style={{ position: "absolute", pointerEvents: "none" }}
            aria-hidden
          >
            <path
              d="M2.5 6.2 L4.8 8.5 L9.5 3.5"
              stroke="#042f1f"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        )}
      </div>

      {/* 右上：来源/模式徽章 */}
      {item.badge && badgeStyle && (
        <span
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 2,
            background: badgeStyle.bg,
            border: `1px solid ${badgeStyle.border}`,
            color: badgeStyle.color,
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            borderRadius: 5,
            padding: "2px 7px",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.2,
          }}
        >
          {item.badge.label}
        </span>
      )}

      {/* 多图左右切换 */}
      {total > 1 && (
        <>
          <button
            aria-label="上一张"
            onClick={(e) => { e.stopPropagation(); setImgIdx((i) => (i - 1 + total) % total); }}
            style={navBtnStyle("left")}
          >
            <LeftOutlined style={{ fontSize: 11 }} />
          </button>
          <button
            aria-label="下一张"
            onClick={(e) => { e.stopPropagation(); setImgIdx((i) => (i + 1) % total); }}
            style={navBtnStyle("right")}
          >
            <RightOutlined style={{ fontSize: 11 }} />
          </button>
          <div
            style={{
              position: "absolute",
              top: 36,
              right: 8,
              zIndex: 2,
              background: "rgba(0, 0, 0, 0.65)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              borderRadius: 6,
              padding: "2px 8px",
              fontSize: 10,
              color: "#e4e4e7",
              fontWeight: 500,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {imgIdx + 1} / {total}
          </div>
        </>
      )}

      {/* 底部深色半透明区：数据 + 操作 */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          background: "linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.55) 35%, rgba(0, 0, 0, 0.92) 100%)",
          padding: "40px 10px 8px",
          zIndex: 1,
        }}
      >
        {/* 标题 */}
        <div
          style={{
            color: "#f4f4f5",
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.35,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            marginBottom: 4,
            wordBreak: "break-word",
          }}
          title={item.title}
        >
          {item.title}
        </div>

        {/* 元数据 */}
        {item.metas.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "2px 6px",
              fontSize: 10,
              color: "#a1a1aa",
              fontVariantNumeric: "tabular-nums",
              marginBottom: 7,
            }}
          >
            {item.metas.map((m, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
                {i > 0 && <span style={{ color: "#52525b", marginRight: 6 }}>·</span>}
                {m.value}
              </span>
            ))}
          </div>
        )}

        {/* 操作按钮行 */}
        <div style={{ display: "flex", gap: 4 }}>
          {onFavorite && currentId && (
            <CardActionButton
              icon={item.favorited ? <StarFilled /> : <StarOutlined />}
              tip={item.favorited ? "取消收藏" : "收藏到素材库"}
              active={item.favorited}
              onClick={(e) => { stop(e); onFavorite(item); }}
            />
          )}
          {onDownload && currentId && (
            <CardActionButton
              icon={<DownloadOutlined />}
              tip="下载"
              onClick={(e) => { stop(e); onDownload(currentId, item); }}
            />
          )}
          {onMatte && currentId && (
            <CardActionButton
              icon={<ScissorOutlined />}
              tip="送入抠图"
              onClick={(e) => { stop(e); onMatte(currentId, item); }}
            />
          )}
          {onReuse && (
            <CardActionButton
              icon={<ReloadOutlined />}
              tip="复用参数"
              onClick={(e) => { stop(e); onReuse(item); }}
            />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function navBtnStyle(side: "left" | "right"): React.CSSProperties {
  return {
    position: "absolute",
    top: "50%",
    [side]: 4,
    transform: "translateY(-50%)",
    width: 24,
    height: 36,
    borderRadius: 6,
    border: "1px solid rgba(255, 255, 255, 0.12)",
    background: "rgba(0, 0, 0, 0.55)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    color: "#e4e4e7",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  };
}

/* ============================================================
 * CardActionButton - 卡片底部小按钮
 * ============================================================ */

function CardActionButton({
  icon, tip, onClick, active, activeColor = "#fbbf24",
}: {
  icon: ReactNode;
  tip: string;
  onClick: (e: React.MouseEvent) => void;
  /** 激活态（如已收藏）：常驻高亮，悬浮不再变绿 */
  active?: boolean;
  activeColor?: string;
}) {
  const idleBg = "rgba(24, 24, 27, 0.78)";
  const idleBorder = "rgba(255, 255, 255, 0.1)";
  const idleColor = "#d4d4d8";
  return (
    <Tooltip title={tip} mouseEnterDelay={0.4}>
      <button
        onClick={onClick}
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          border: active ? `1px solid ${activeColor}66` : `1px solid ${idleBorder}`,
          background: active ? `${activeColor}26` : idleBg,
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          color: active ? activeColor : idleColor,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          transition: "all 0.15s ease",
        }}
        onMouseEnter={(e) => {
          if (active) return;
          e.currentTarget.style.background = "rgba(16, 185, 129, 0.22)";
          e.currentTarget.style.borderColor = "rgba(16, 185, 129, 0.45)";
          e.currentTarget.style.color = "#34d399";
        }}
        onMouseLeave={(e) => {
          if (active) return;
          e.currentTarget.style.background = idleBg;
          e.currentTarget.style.borderColor = idleBorder;
          e.currentTarget.style.color = idleColor;
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

/* ============================================================
 * MediaGallery - 主组件
 * ============================================================ */

export function MediaGallery({
  items,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  onPreview,
  onDownload,
  onMatte,
  onReuse,
  onFavorite,
  onDelete,
  pageSize = 24,
}: MediaGalleryProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const pageItems = useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, safePage, pageSize]
  );

  // 清理失效的选择（删除后或筛选变化导致某些 id 不再存在）
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(items.map((i) => i.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (valid.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [items]);

  // 列表收缩导致当前页超界时回退
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageIds = pageItems.map((i) => i.id);
  const selectedOnPageCount = pageIds.reduce((n, id) => n + (selectedIds.has(id) ? 1 : 0), 0);

  const pageCheckboxChecked = selectedOnPageCount > 0 && selectedOnPageCount === pageIds.length;
  const pageCheckboxIndeterminate = selectedOnPageCount > 0 && !pageCheckboxChecked;

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePageSelection = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      // 已有部分或全部选中 -> 取消本页；空 -> 选中本页
      if (selectedOnPageCount > 0) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [pageIds, selectedOnPageCount]);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(items.map((i) => i.id)));
  }, [items]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  function handleDelete() {
    if (selectedIds.size === 0) return;
    onDelete(Array.from(selectedIds));
    setSelectedIds(new Set());
    // 成功提示由消费方在 onDelete 中自行处理，以便区分“已收藏素材保留”等场景
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={emptyIcon ?? <PictureOutlined />}
        title={emptyTitle}
        description={emptyDescription}
        minHeight={320}
      />
    );
  }

  return (
    <div>
      {/* 工具栏：选择 + 批量删除 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "10px 14px",
          marginBottom: 14,
          background: "rgba(24, 24, 27, 0.6)",
          border: "1px solid #27272a",
          borderRadius: 10,
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
        }}
      >
        <Checkbox
          checked={pageCheckboxChecked}
          indeterminate={pageCheckboxIndeterminate}
          onChange={togglePageSelection}
          style={{ color: "#d4d4d8" }}
        >
          全选本页
        </Checkbox>

        <Button size="small" type="link" onClick={selectAll} style={{ padding: 0, height: 24 }}>
          选择全部
        </Button>

        {selectedIds.size > 0 && (
          <Button size="small" type="link" onClick={clearSelection} style={{ padding: 0, height: 24 }}>
            清空选择
          </Button>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              color: "#71717a",
              fontSize: 12,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            已选 {selectedIds.size} / 共 {items.length} 项
          </span>
          <Popconfirm
            title={`确认删除选中的 ${selectedIds.size} 项？`}
            description="此操作不可撤销"
            onConfirm={handleDelete}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={selectedIds.size === 0}
          >
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={selectedIds.size === 0}
              size="small"
            >
              删除选中{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
            </Button>
          </Popconfirm>
        </div>
      </div>

      {/* 卡片网格 */}
      <motion.div
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
        }}
        initial="hidden"
        animate="show"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        {pageItems.map((item) => (
          <MediaCard
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            onToggleSelect={toggleSelect}
            onPreview={onPreview}
            onDownload={onDownload}
            onMatte={onMatte}
            onReuse={onReuse}
            onFavorite={onFavorite}
          />
        ))}
      </motion.div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginTop: 28,
          }}
        >
          <Pagination
            current={safePage}
            total={items.length}
            pageSize={pageSize}
            onChange={setPage}
            showSizeChanger={false}
            showQuickJumper={items.length > pageSize * 5}
          />
        </div>
      )}
    </div>
  );
}
