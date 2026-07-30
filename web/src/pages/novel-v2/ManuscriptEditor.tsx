import { useEffect, useRef } from "react";

export interface ManuscriptEditorProps {
  value: string;
  onChange?: (plainText: string) => void;
  editable?: boolean;
  placeholder?: string;
  minHeight?: number;
  autofocus?: boolean;
  activeParagraph?: number;
}

export function ManuscriptEditor({
  value,
  onChange,
  editable = true,
  placeholder = "在此撰写或修改正文...",
  minHeight = 360,
  autofocus = false,
  activeParagraph,
}: ManuscriptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (activeParagraph === undefined || !textareaRef.current) return;
    const paragraphs = value.split(/\n\s*\n/gu);
    const start = paragraphs.slice(0, activeParagraph).reduce((length, paragraph) => length + paragraph.length + 2, 0);
    const end = start + (paragraphs[activeParagraph]?.length ?? 0);
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(start, end);
  }, [activeParagraph, value]);

  return (
    <div className={`me-editor me-plain-editor ${editable ? "" : "is-readonly"}`} style={{ ["--me-min-height" as string]: `${minHeight}px` }}>
      <textarea
        ref={textareaRef}
        className="me-plain-input"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        readOnly={!editable}
        placeholder={placeholder}
        autoFocus={autofocus}
        spellCheck
        aria-label={editable ? "章节正文编辑器" : "章节正文"}
      />
      <div className="me-footer"><span>{value.length.toLocaleString()} 字</span></div>
    </div>
  );
}

export default ManuscriptEditor;
