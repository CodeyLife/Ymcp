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


__all__ = [
    "TimingMapSpec",
    "TimingPoint",
    "map_output_to_source",
    "output_frame_source_indices",
    "timing_preset",
    "validate_timing_points",
]
