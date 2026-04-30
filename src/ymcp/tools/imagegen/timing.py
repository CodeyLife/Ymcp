"""Timing-remap helpers for v2f editor workflows.

The timing map is intentionally deterministic: v1 maps output animation
progress to cached source-frame progress and chooses the nearest cached frame.
It does not synthesize in-between frames.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal


InterpolationMode = Literal["linear"]


@dataclass(frozen=True)
class TimingPoint:
    """A normalized timing-map control point.

    ``output`` is output animation progress in ``[0, 1]``.
    ``source`` is source frame/video progress in ``[0, 1]``.
    """

    output: float
    source: float


@dataclass(frozen=True)
class TimingMapSpec:
    """Monotonic mapping from output progress to source progress."""

    points: tuple[TimingPoint, ...] = (TimingPoint(0.0, 0.0), TimingPoint(1.0, 1.0))
    interpolation: InterpolationMode = "linear"
    preset: str | None = None

    def __post_init__(self) -> None:
        validate_timing_points(self.points)
        if self.interpolation != "linear":
            raise ValueError("only linear timing interpolation is supported")


@dataclass(frozen=True)
class SpeedKeyframe:
    """Playback-speed control point at a source-video timestamp."""

    time_seconds: float
    before_speed: float
    after_speed: float


def _clamp_unit(value: float) -> float:
    return max(0.0, min(1.0, value))


def validate_timing_points(points: Iterable[TimingPoint]) -> tuple[TimingPoint, ...]:
    normalized = tuple(points)
    if len(normalized) < 2:
        raise ValueError("timing map requires at least two points")
    if normalized[0] != TimingPoint(0.0, 0.0):
        raise ValueError("timing map must start at (0, 0)")
    if normalized[-1] != TimingPoint(1.0, 1.0):
        raise ValueError("timing map must end at (1, 1)")

    previous_output = -1.0
    previous_source = -1.0
    for point in normalized:
        if not (0.0 <= point.output <= 1.0 and 0.0 <= point.source <= 1.0):
            raise ValueError("timing map points must be normalized to [0, 1]")
        if point.output <= previous_output:
            raise ValueError("timing map output positions must be strictly increasing")
        if point.source < previous_source:
            raise ValueError("timing map source positions must be monotonic")
        previous_output = point.output
        previous_source = point.source
    return normalized


def timing_preset(name: str) -> TimingMapSpec:
    """Return a named v2f timing preset."""

    presets: dict[str, tuple[TimingPoint, ...]] = {
        "linear": (TimingPoint(0.0, 0.0), TimingPoint(1.0, 1.0)),
        "hold_then_burst": (
            TimingPoint(0.0, 0.0),
            TimingPoint(0.35, 0.08),
            TimingPoint(0.55, 0.14),
            TimingPoint(0.80, 0.78),
            TimingPoint(1.0, 1.0),
        ),
        "slow_in_fast_out": (
            TimingPoint(0.0, 0.0),
            TimingPoint(0.35, 0.18),
            TimingPoint(0.70, 0.55),
            TimingPoint(1.0, 1.0),
        ),
        "burst_then_settle": (
            TimingPoint(0.0, 0.0),
            TimingPoint(0.25, 0.58),
            TimingPoint(0.65, 0.88),
            TimingPoint(1.0, 1.0),
        ),
        "anticipation_explosion": (
            TimingPoint(0.0, 0.0),
            TimingPoint(0.30, 0.10),
            TimingPoint(0.45, 0.12),
            TimingPoint(0.62, 0.72),
            TimingPoint(1.0, 1.0),
        ),
    }
    key = name.strip().lower().replace("-", "_")
    if key not in presets:
        available = ", ".join(sorted(presets))
        raise ValueError(f"unknown timing preset {name!r}; available: {available}")
    return TimingMapSpec(points=presets[key], preset=key)


def map_output_to_source(progress: float, spec: TimingMapSpec | None = None) -> float:
    """Map normalized output progress to normalized source progress."""

    active = spec or TimingMapSpec()
    value = _clamp_unit(progress)
    points = active.points
    for left, right in zip(points, points[1:]):
        if value <= right.output:
            span = right.output - left.output
            if span <= 0:
                return right.source
            local_t = (value - left.output) / span
            return _clamp_unit(left.source + (right.source - left.source) * local_t)
    return points[-1].source


def output_frame_source_indices(output_count: int, source_count: int, spec: TimingMapSpec | None = None) -> list[int]:
    """Return deterministic nearest-source-frame indices for an output sequence."""

    if output_count < 1:
        raise ValueError("output_count must be at least 1")
    if source_count < 1:
        raise ValueError("source_count must be at least 1")
    if output_count == 1:
        progresses = [0.0]
    else:
        progresses = [index / float(output_count - 1) for index in range(output_count)]
    max_source_index = source_count - 1
    return [round(map_output_to_source(progress, spec) * max_source_index) for progress in progresses]


def timing_from_speed_keyframes(
    duration_seconds: float,
    keyframes: Iterable[SpeedKeyframe],
    *,
    samples: int = 80,
) -> TimingMapSpec:
    """Build a TimingMapSpec from source-time speed keyframes.

    Speed is interpreted as source playback speed. For example, speed ``0.4``
    before a 1s keyframe means source time advances slowly from 0s to 1s. The
    interval between two keyframes interpolates from the left keyframe's
    ``after_speed`` to the right keyframe's ``before_speed``. The final
    interval interpolates from the last keyframe's ``before_speed`` to its
    ``after_speed``. Output-time position is computed by integrating
    ``dt_source / speed`` and normalizing the cumulative output time.
    """

    if duration_seconds <= 0:
        raise ValueError("duration_seconds must be positive")
    if samples < 2:
        raise ValueError("samples must be at least 2")
    ordered = tuple(sorted(keyframes, key=lambda item: item.time_seconds))
    previous_time = 0.0
    for keyframe in ordered:
        if not (0.0 < keyframe.time_seconds < duration_seconds):
            raise ValueError("speed keyframe time must be inside the video duration")
        if keyframe.time_seconds <= previous_time:
            raise ValueError("speed keyframes must have strictly increasing times")
        if keyframe.before_speed <= 0 or keyframe.after_speed <= 0:
            raise ValueError("speed values must be positive")
        previous_time = keyframe.time_seconds

    source_times = [duration_seconds * index / float(samples - 1) for index in range(samples)]
    cumulative = [0.0]
    for left, right in zip(source_times, source_times[1:]):
        midpoint = (left + right) / 2.0
        speed = _speed_at_source_time(midpoint, duration_seconds, ordered)
        cumulative.append(cumulative[-1] + ((right - left) / speed))
    total_output = cumulative[-1]
    if total_output <= 0:
        raise ValueError("speed keyframes produced an invalid output duration")
    points = tuple(
        TimingPoint(
            output=_clamp_unit(output_time / total_output),
            source=_clamp_unit(source_time / duration_seconds),
        )
        for source_time, output_time in zip(source_times, cumulative)
    )
    return TimingMapSpec(points=_dedupe_timing_points(points), preset="speed_keyframes")


def _speed_at_source_time(time_seconds: float, duration_seconds: float, keyframes: tuple[SpeedKeyframe, ...]) -> float:
    if not keyframes:
        return 1.0
    first = keyframes[0]
    if time_seconds <= first.time_seconds:
        return first.before_speed
    for left, right in zip(keyframes, keyframes[1:]):
        if time_seconds <= right.time_seconds:
            span = right.time_seconds - left.time_seconds
            local_t = (time_seconds - left.time_seconds) / span if span > 0 else 0.0
            return left.after_speed + (right.before_speed - left.after_speed) * local_t
    last = keyframes[-1]
    tail_span = duration_seconds - last.time_seconds
    if tail_span <= 0:
        return last.after_speed
    local_t = (time_seconds - last.time_seconds) / tail_span
    return last.before_speed + (last.after_speed - last.before_speed) * local_t


def _dedupe_timing_points(points: tuple[TimingPoint, ...]) -> tuple[TimingPoint, ...]:
    deduped = [points[0]]
    for point in points[1:-1]:
        if point.output > deduped[-1].output and point.source >= deduped[-1].source:
            deduped.append(point)
    if deduped[-1] != TimingPoint(1.0, 1.0):
        deduped.append(TimingPoint(1.0, 1.0))
    return tuple(deduped)


__all__ = [
    "TimingMapSpec",
    "TimingPoint",
    "SpeedKeyframe",
    "map_output_to_source",
    "output_frame_source_indices",
    "timing_from_speed_keyframes",
    "timing_preset",
    "validate_timing_points",
]
