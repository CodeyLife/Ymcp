"""Local single-user v2f editor session cache."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, is_dataclass
from pathlib import Path
import shutil
import tempfile
import time
from uuid import uuid4
from typing import Any

from ymcp.tools.imagegen.timing import TimingMapSpec, timing_preset
from ymcp.tools.imagegen.v2f_core import (
    CapturePlan,
    ExportSpec,
    FrameSet,
    FramesheetPlan,
    PreviewSpec,
    VisualPipelineSpec,
    capture_video_frames,
    export_framesheet_webp,
    frameset_from_framesheet,
    preview_frames,
    render_frames,
)
from ymcp.tools.imagegen.local_frame_workflow import near_square_columns, save_gif, save_sprite_sheet, _save_webp_animation_with_ffmpeg


def _safe_payload(value: Any) -> Any:
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, Path):
        return str(value)
    return value


def resolve_safe_path(raw: str | Path, *, must_exist: bool = False, base: str | Path | None = None) -> Path:
    """Resolve a path and reject traversal outside ``base`` when provided."""

    path = Path(raw).expanduser().resolve()
    if must_exist and not path.exists():
        raise FileNotFoundError(f"路径不存在：{path}")
    if base is not None:
        root = Path(base).expanduser().resolve()
        if path != root and root not in path.parents:
            raise ValueError(f"路径必须位于 {root} 内：{path}")
    return path


@dataclass
class V2FSession:
    id: str
    temp_root: Path
    frame_set: FrameSet | None = None
    visual_spec: VisualPipelineSpec = field(default_factory=VisualPipelineSpec)
    timing_spec: TimingMapSpec = field(default_factory=TimingMapSpec)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    preview_path: Path | None = None
    export_path: Path | None = None

    def touch(self) -> None:
        self.updated_at = time.time()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_kind": self.frame_set.source_kind if self.frame_set else None,
            "frame_count": self.frame_set.frame_count if self.frame_set else 0,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "preview_path": str(self.preview_path) if self.preview_path else None,
            "export_path": str(self.export_path) if self.export_path else None,
        }


class V2FSessionStore:
    """In-process local session store for the v2f editor."""

    def __init__(self, root: str | Path | None = None, *, allow_external_exports: bool = False) -> None:
        self.root = Path(root) if root is not None else Path(tempfile.mkdtemp(prefix="ymcp-v2f-ui-"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.sessions: dict[str, V2FSession] = {}
        self.allow_external_exports = allow_external_exports
        self.upload_root = self.root / "uploads"
        self.upload_root.mkdir(parents=True, exist_ok=True)

    def create_empty(self) -> V2FSession:
        session_id = uuid4().hex
        session = V2FSession(id=session_id, temp_root=self.root / session_id)
        session.temp_root.mkdir(parents=True, exist_ok=True)
        self.sessions[session_id] = session
        return session

    def create_from_framesheet(self, source: str | Path, grid: str | tuple[int, int]) -> V2FSession:
        path = resolve_safe_path(source, must_exist=True)
        session = self.create_empty()
        session.frame_set = frameset_from_framesheet(FramesheetPlan(path, grid))
        session.touch()
        return session

    def save_upload(self, filename: str, data: bytes) -> Path:
        """Save a browser-uploaded file under the store's local upload root."""

        clean_name = Path(filename).name or "upload.bin"
        target = self.upload_root / f"{uuid4().hex}-{clean_name}"
        target.write_bytes(data)
        return target.resolve()

    def capture_video(self, session_id: str, plan: CapturePlan) -> V2FSession:
        session = self.get(session_id)
        source = resolve_safe_path(plan.source, must_exist=False)
        normalized = CapturePlan(source=source, count=plan.count, seconds=plan.seconds, decode_size=plan.decode_size)
        if session.frame_set is not None and session.frame_set.cache_key == normalized.cache_key():
            session.touch()
            return session
        session.frame_set = capture_video_frames(normalized)
        session.touch()
        return session

    def get(self, session_id: str) -> V2FSession:
        if session_id not in self.sessions:
            raise KeyError(f"未知 v2f 会话：{session_id}")
        return self.sessions[session_id]

    def update_visual(self, session_id: str, spec: VisualPipelineSpec) -> V2FSession:
        session = self.get(session_id)
        session.visual_spec = spec
        session.touch()
        return session

    def update_timing(self, session_id: str, spec: TimingMapSpec) -> V2FSession:
        session = self.get(session_id)
        session.timing_spec = spec
        session.touch()
        return session

    def apply_timing_preset(self, session_id: str, preset: str) -> V2FSession:
        return self.update_timing(session_id, timing_preset(preset))

    def render_preview(self, session_id: str, spec: PreviewSpec | None = None) -> Path:
        session = self.get(session_id)
        if session.frame_set is None:
            raise ValueError("当前会话还没有帧")
        frames = preview_frames(session.frame_set, session.visual_spec, session.timing_spec, spec)
        preview_dir = session.temp_root / "preview"
        preview_dir.mkdir(parents=True, exist_ok=True)
        out_path = preview_dir / "preview.webp"
        duration = 80
        from ymcp.tools.imagegen.local_frame_workflow import save_webp

        save_webp(frames, out_path, duration_ms=duration, loop=0, lossless=True)
        session.preview_path = out_path
        session.touch()
        return out_path

    def _resolve_export_target(self, session: V2FSession, out_dir: str | Path | None) -> Path:
        if out_dir is None:
            return session.temp_root / "export"
        if self.allow_external_exports:
            return Path(out_dir).expanduser().resolve()
        return resolve_safe_path(out_dir, base=session.temp_root)

    def _render_export_frames(self, session: V2FSession) -> list[object]:
        if session.frame_set is None:
            raise ValueError("当前会话还没有帧")
        return render_frames(session.frame_set, session.visual_spec, session.timing_spec)

    def cache_summary(self, session_id: str) -> dict[str, Any]:
        session = self.get(session_id)
        frame_set = session.frame_set
        return {
            "cached_in_memory": frame_set is not None,
            "frame_count": frame_set.frame_count if frame_set else 0,
            "source_kind": frame_set.source_kind if frame_set else None,
            "cache_key": frame_set.cache_key if frame_set else None,
        }

    def export(self, session_id: str, out_dir: str | Path | None = None, spec: ExportSpec | None = None) -> Path:
        session = self.get(session_id)
        target = self._resolve_export_target(session, out_dir)
        frames = self._render_export_frames(session)
        output = export_framesheet_webp(frames, target, spec)
        session.export_path = output
        session.touch()
        return output

    def export_framesheet(self, session_id: str, out_dir: str | Path | None = None, spec: ExportSpec | None = None) -> Path:
        session = self.get(session_id)
        target = self._resolve_export_target(session, out_dir)
        target.mkdir(parents=True, exist_ok=True)
        frames = self._render_export_frames(session)
        active = spec or ExportSpec()
        columns = active.columns or near_square_columns(len(frames))
        out_path = save_sprite_sheet(frames, target / "framesheet.png", columns=columns)
        session.export_path = target
        session.touch()
        return out_path

    def export_webp(self, session_id: str, out_dir: str | Path | None = None, spec: ExportSpec | None = None) -> Path:
        session = self.get(session_id)
        target = self._resolve_export_target(session, out_dir)
        target.mkdir(parents=True, exist_ok=True)
        frames = self._render_export_frames(session)
        active = spec or ExportSpec()
        out_path = _save_webp_animation_with_ffmpeg(frames, target / "animation.webp", duration_ms=active.duration_ms, loop=active.loop, lossless=active.lossless)
        session.export_path = target
        session.touch()
        return out_path

    def export_gif(self, session_id: str, out_dir: str | Path | None = None, spec: ExportSpec | None = None) -> Path:
        session = self.get(session_id)
        target = self._resolve_export_target(session, out_dir)
        target.mkdir(parents=True, exist_ok=True)
        frames = self._render_export_frames(session)
        active = spec or ExportSpec()
        out_path = save_gif(frames, target / "animation.gif", duration_ms=active.duration_ms, loop=active.loop, disposal=2)
        session.export_path = target
        session.touch()
        return out_path

    def reset(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, None)
        if session is not None and session.temp_root.exists():
            shutil.rmtree(session.temp_root, ignore_errors=True)

    def cleanup(self, *, max_age_seconds: float | None = None) -> int:
        now = time.time()
        removed = 0
        for session_id, session in list(self.sessions.items()):
            if max_age_seconds is None or now - session.updated_at > max_age_seconds:
                self.reset(session_id)
                removed += 1
        return removed

    def close(self) -> None:
        for session_id in list(self.sessions):
            self.reset(session_id)
        if self.root.exists():
            shutil.rmtree(self.root, ignore_errors=True)

    def status(self, session_id: str) -> dict[str, Any]:
        session = self.get(session_id)
        payload = session.to_dict()
        payload["visual_spec"] = _safe_payload(session.visual_spec)
        payload["timing_spec"] = _safe_payload(session.timing_spec)
        return payload


__all__ = ["V2FSession", "V2FSessionStore", "resolve_safe_path"]
