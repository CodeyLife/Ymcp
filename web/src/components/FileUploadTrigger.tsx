import { useRef, useState, type ReactNode } from "react";
import { InboxOutlined, UploadOutlined } from "@ant-design/icons";

export type FileUploadTriggerProps = {
  accept: string;
  multiple?: boolean;
  label: string;
  hint?: string;
  selectedText?: string;
  icon?: ReactNode;
  block?: boolean;
  variant?: "button" | "dropzone";
  onFiles: (files: FileList) => void | Promise<void>;
};

export function FileUploadTrigger({
  accept,
  multiple,
  label,
  hint,
  selectedText,
  icon,
  block,
  variant = "button",
  onFiles,
}: FileUploadTriggerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const isDropzone = variant === "dropzone";

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    await onFiles(files);
    if (inputRef.current) inputRef.current.value = "";
  }

  function openPicker() {
    inputRef.current?.click();
  }

  function handleDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => handleFiles(e.target.files)}
        style={{ display: "none" }}
      />
      <button
        type="button"
        className={[
          "file-upload-trigger",
          isDropzone ? "file-upload-trigger-dropzone" : "file-upload-trigger-button",
          block ? "file-upload-trigger-block" : "",
          dragging ? "file-upload-trigger-dragging" : "",
        ].filter(Boolean).join(" ")}
        onClick={openPicker}
        onDragOver={isDropzone ? (e) => { e.preventDefault(); setDragging(true); } : undefined}
        onDragLeave={isDropzone ? () => setDragging(false) : undefined}
        onDrop={isDropzone ? handleDrop : undefined}
      >
        <span className="file-upload-trigger-icon">
          {icon ?? (isDropzone ? <InboxOutlined /> : <UploadOutlined />)}
        </span>
        <span className="file-upload-trigger-copy">
          <span className="file-upload-trigger-label">{label}</span>
          {(hint || selectedText) && (
            <span className="file-upload-trigger-hint">
              {selectedText || hint}
            </span>
          )}
        </span>
      </button>
    </>
  );
}
