/* ============================================================
 * ManuscriptEditor — 基于 tiptap 的正文编辑器（替换大 TextArea）
 *
 * 小说正文为纯文本（空行分段），这里用 tiptap 提供富文本编辑体验：
 * - StarterKit（段落/标题/加粗/斜体/删除线/列表/引用/分隔线/历史）
 * - Placeholder（占位提示）、CharacterCount（字数统计）
 * - 输入输出均为纯文本：plainText ↔ HTML 互转，段落以空行分隔
 * - 受控方式：父组件用 key 变化实现「重置为原文」
 * ============================================================ */

import { useEffect, useMemo, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import {
  BoldOutlined,
  ItalicOutlined,
  StrikethroughOutlined,
  UndoOutlined,
  RedoOutlined,
  UnorderedListOutlined,
  OrderedListOutlined,
  LineOutlined,
} from "@ant-design/icons";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 纯文本 → tiptap HTML（空行分段，段内单换行转 <br>） */
export function plainTextToHtml(text: string): string {
  const paras = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!paras.length) return "<p></p>";
  return paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

/** tiptap 编辑器 → 纯文本（块级之间空行） */
export function editorToPlainText(editor: Editor): string {
  return editor.getText({ blockSeparator: "\n\n" });
}

interface ToolbarButton {
  key: string;
  icon: ReactNode;
  title: string;
  active?: (e: Editor) => boolean;
  run: (e: Editor) => void;
  disabled?: (e: Editor) => boolean;
}

function Toolbar({ editor }: { editor: Editor }) {
  const buttons: ToolbarButton[] = [
    { key: "bold", icon: <BoldOutlined />, title: "加粗", active: (e) => e.isActive("bold"), run: (e) => e.chain().focus().toggleBold().run() },
    { key: "italic", icon: <ItalicOutlined />, title: "斜体", active: (e) => e.isActive("italic"), run: (e) => e.chain().focus().toggleItalic().run() },
    { key: "strike", icon: <StrikethroughOutlined />, title: "删除线", active: (e) => e.isActive("strike"), run: (e) => e.chain().focus().toggleStrike().run() },
    { key: "h2", icon: <span className="me-tb-text">H2</span>, title: "二级标题", active: (e) => e.isActive("heading", { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { key: "h3", icon: <span className="me-tb-text">H3</span>, title: "三级标题", active: (e) => e.isActive("heading", { level: 3 }), run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
    { key: "bullet", icon: <UnorderedListOutlined />, title: "无序列表", active: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
    { key: "ordered", icon: <OrderedListOutlined />, title: "有序列表", active: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
    { key: "quote", icon: <span className="me-tb-text">❝</span>, title: "引用", active: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
    { key: "hr", icon: <LineOutlined />, title: "分隔线", run: (e) => e.chain().focus().setHorizontalRule().run() },
    { key: "undo", icon: <UndoOutlined />, title: "撤销", run: (e) => e.chain().focus().undo().run(), disabled: (e) => !e.can().chain().focus().undo().run() },
    { key: "redo", icon: <RedoOutlined />, title: "重做", run: (e) => e.chain().focus().redo().run(), disabled: (e) => !e.can().chain().focus().redo().run() },
  ];
  return (
    <div className="me-toolbar" role="toolbar" aria-label="正文编辑工具栏">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          title={b.title}
          aria-label={b.title}
          className={`me-tb-btn ${b.active?.(editor) ? "is-active" : ""}`}
          disabled={b.disabled?.(editor) ?? false}
          onClick={() => b.run(editor)}
        >
          {b.icon}
        </button>
      ))}
    </div>
  );
}

export interface ManuscriptEditorProps {
  /** 初始纯文本（仅挂载时读取；外部重置请改 key） */
  value: string;
  onChange?: (plainText: string) => void;
  editable?: boolean;
  placeholder?: string;
  minHeight?: number;
  autofocus?: boolean;
}

export function ManuscriptEditor({ value, onChange, editable = true, placeholder = "在此撰写或修改正文…", minHeight = 360, autofocus = false }: ManuscriptEditorProps) {
  const initialContent = useMemo(() => plainTextToHtml(value), []); // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder }),
      CharacterCount,
    ],
    content: initialContent,
    editable,
    autofocus,
    onUpdate: ({ editor }) => onChange?.(editorToPlainText(editor)),
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const characters = editor?.storage.characterCount.characters() ?? 0;

  return (
    <div className={`me-editor ${editable ? "" : "is-readonly"}`} style={{ ["--me-min-height" as string]: `${minHeight}px` }}>
      {editable && editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="me-content" />
      <div className="me-footer">
        <span>{characters} 字</span>
      </div>
    </div>
  );
}

export default ManuscriptEditor;
