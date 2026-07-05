import type { MouseEvent, PointerEvent, ReactNode } from "react";

export interface ImagePreviewAction {
  key: string;
  title: string;
  icon: ReactNode;
  active?: boolean;
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
  href?: string;
  download?: string;
  onClick?: () => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  onPointerLeave?: () => void;
  onPointerCancel?: () => void;
}

interface ImagePreviewActionToolbarProps {
  originalNode?: ReactNode;
  actions: ImagePreviewAction[];
}

export function ImagePreviewActionToolbar({ originalNode, actions }: ImagePreviewActionToolbarProps) {
  return (
    <div className="image-preview-toolbar-with-action">
      {originalNode}
      {originalNode && actions.length > 0 && <span className="image-preview-action-separator" aria-hidden />}
      {actions.map((action) => {
        const className = [
          "image-preview-img2img-button",
          action.active ? "image-preview-favorite-active" : "",
          action.pressed ? "image-preview-button-pressed" : "",
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
          onPointerDown: (event: PointerEvent<HTMLElement>) => {
            event.stopPropagation();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            action.onPointerDown?.();
          },
          onPointerUp: (event: PointerEvent<HTMLElement>) => {
            event.stopPropagation();
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            action.onPointerUp?.();
          },
          onPointerLeave: (event: PointerEvent<HTMLElement>) => {
            event.stopPropagation();
            action.onPointerLeave?.();
          },
          onPointerCancel: (event: PointerEvent<HTMLElement>) => {
            event.stopPropagation();
            action.onPointerCancel?.();
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
