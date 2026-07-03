import type { MouseEvent, ReactNode } from "react";

export interface ImagePreviewAction {
  key: string;
  title: string;
  icon: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  href?: string;
  download?: string;
  onClick?: () => void;
}

interface ImagePreviewActionToolbarProps {
  originalNode: ReactNode;
  actions: ImagePreviewAction[];
}

export function ImagePreviewActionToolbar({ originalNode, actions }: ImagePreviewActionToolbarProps) {
  return (
    <div className="image-preview-toolbar-with-action">
      {originalNode}
      {actions.length > 0 && <span className="image-preview-action-separator" aria-hidden />}
      {actions.map((action) => {
        const className = [
          "image-preview-img2img-button",
          action.active ? "image-preview-favorite-active" : "",
          action.danger ? "image-preview-danger-button" : "",
        ].filter(Boolean).join(" ");
        const commonProps = {
          className,
          title: action.title,
          "aria-label": action.title,
          onClick: (event: MouseEvent<HTMLElement>) => {
            event.stopPropagation();
            action.onClick?.();
          },
        };

        if (action.href) {
          return (
            <a
              key={action.key}
              {...commonProps}
              href={action.href}
              download={action.download}
            >
              {action.icon}
            </a>
          );
        }

        return (
          <button
            key={action.key}
            type="button"
            {...commonProps}
            disabled={action.disabled}
          >
            {action.icon}
          </button>
        );
      })}
    </div>
  );
}
