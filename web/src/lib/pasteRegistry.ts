/**
 * 粘贴注册中心
 * ============================================================
 * 单例式管理所有支持 Ctrl+V 粘贴的上传目标。
 * - 模块加载时在 window 上挂载唯一的 paste 监听器
 * - 页面仅有一个图片目标时，全页面任意位置按 Ctrl+V 都路由到它
 * - 多个目标时，以鼠标悬停的目标为准
 * - 通过 useSyncExternalStore 友好的订阅接口，让组件响应激活态变化
 */

export type PasteHandler = (files: FileList) => void | Promise<void>;

export type PasteTarget = {
  id: string;
  accept: string;
  multiple: boolean;
  handlerRef: { current: PasteHandler };
};

const targets = new Map<string, PasteTarget>();
let hoveredId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((cb) => cb());
}

function getActiveId(): string | null {
  if (targets.size === 0) return null;
  if (targets.size === 1) return targets.keys().next().value ?? null;
  return hoveredId && targets.has(hoveredId) ? hoveredId : null;
}

// accept 解析：支持 image/*（前缀）、image/png（精确）、.png（扩展名）
function matchAccept(file: File, rule: string): boolean {
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  if (r === "*/*" || r === "image/*") return file.type.startsWith("image/");
  if (r.startsWith(".")) return file.name.toLowerCase().endsWith(r);
  return file.type.toLowerCase() === r;
}

function filterFilesByAccept(files: FileList, accept: string): File[] {
  const rules = accept.split(",").map((s) => s.trim()).filter(Boolean);
  if (rules.length === 0) return Array.from(files);
  return Array.from(files).filter((f) => rules.some((r) => matchAccept(f, r)));
}

/** 仅当 accept 含至少一个 image/* 规则时才视为图片目标（自动排除 video/* 等） */
export function isImageAccept(accept: string): boolean {
  return accept
    .split(",")
    .some((r) => r.trim().toLowerCase().startsWith("image/"));
}

function handlePaste(e: ClipboardEvent): void {
  // 1. 先读取剪切板文件；如果没有图片文件，再放行给输入框做普通文本粘贴
  const files = e.clipboardData?.files;
  if (!files || files.length === 0) return;

  // 2. 解析激活目标
  const activeId = getActiveId();
  if (!activeId) return;
  const pasteTarget = targets.get(activeId);
  if (!pasteTarget) return;

  // 3. 按 accept 过滤
  const accepted = filterFilesByAccept(files, pasteTarget.accept);
  if (accepted.length === 0) return;

  // 4. 按 multiple 决定取全部还是首个，转回 FileList 调用 handler
  e.preventDefault();
  const dt = new DataTransfer();
  accepted
    .slice(0, pasteTarget.multiple ? undefined : 1)
    .forEach((f) => dt.items.add(f));
  pasteTarget.handlerRef.current(dt.files);
}

if (typeof window !== "undefined") {
  window.addEventListener("paste", handlePaste);
}

export function registerPasteTarget(t: PasteTarget): void {
  targets.set(t.id, t);
  emit();
}

export function unregisterPasteTarget(id: string): void {
  if (!targets.has(id)) return;
  targets.delete(id);
  if (hoveredId === id) hoveredId = null;
  emit();
}

/** 仅更新 handler ref，不触发重渲染（用于每次渲染同步最新 onFiles） */
export function updatePasteHandler(id: string, handler: PasteHandler): void {
  const t = targets.get(id);
  if (t) t.handlerRef.current = handler;
}

export function setHoveredTarget(id: string | null): void {
  if (hoveredId === id) return;
  hoveredId = id;
  emit();
}

export function subscribePasteState(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getActivePasteId(): string | null {
  return getActiveId();
}
