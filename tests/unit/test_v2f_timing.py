import pytest

from ymcp.tools.imagegen.timing import (
    SpeedKeyframe,
    TimingMapSpec,
    TimingPoint,
    map_output_to_source,
    output_frame_source_indices,
    timing_from_speed_keyframes,
    timing_preset,
)


def test_timing_map_linear_mapping_is_deterministic():
    spec = TimingMapSpec()

    assert map_output_to_source(0.5, spec) == 0.5
    assert output_frame_source_indices(5, 5, spec) == [0, 1, 2, 3, 4]


def test_timing_preset_hold_then_burst_creates_early_hold():
    spec = timing_preset("hold_then_burst")

    assert spec.preset == "hold_then_burst"
    assert map_output_to_source(0.4, spec) < 0.2
    assert map_output_to_source(0.8, spec) == pytest.approx(0.78)


def test_timing_map_rejects_non_monotonic_points():
    with pytest.raises(ValueError, match="monotonic"):
        TimingMapSpec(points=(TimingPoint(0.0, 0.0), TimingPoint(0.5, 0.8), TimingPoint(0.75, 0.7), TimingPoint(1.0, 1.0)))


def test_timing_map_requires_normalized_endpoints():
    with pytest.raises(ValueError, match="start"):
        TimingMapSpec(points=(TimingPoint(0.1, 0.0), TimingPoint(1.0, 1.0)))

    with pytest.raises(ValueError, match="end"):
        TimingMapSpec(points=(TimingPoint(0.0, 0.0), TimingPoint(0.9, 1.0)))


def test_speed_keyframes_build_source_time_speed_curve():
    spec = timing_from_speed_keyframes(
        8.0,
        (
            SpeedKeyframe(time_seconds=1.0, before_speed=0.4, after_speed=5.0),
            SpeedKeyframe(time_seconds=5.0, before_speed=2.0, after_speed=1.0),
        ),
        samples=161,
    )

    assert spec.preset == "speed_keyframes"
    assert spec.points[0] == TimingPoint(0.0, 0.0)
    assert spec.points[-1] == TimingPoint(1.0, 1.0)
    assert all(left.output < right.output for left, right in zip(spec.points, spec.points[1:]))
    assert all(left.source <= right.source for left, right in zip(spec.points, spec.points[1:]))

    output_at_first_keyframe = min(spec.points, key=lambda point: abs(point.source - 0.125)).output
    output_at_second_keyframe = min(spec.points, key=lambda point: abs(point.source - 0.625)).output
    assert output_at_first_keyframe > 0.25
    assert 0.45 < output_at_second_keyframe < 0.75


def test_speed_keyframes_validate_inputs():
    with pytest.raises(ValueError, match="duration_seconds"):
        timing_from_speed_keyframes(0.0, ())

    with pytest.raises(ValueError, match="inside"):
        timing_from_speed_keyframes(2.0, (SpeedKeyframe(time_seconds=2.0, before_speed=1.0, after_speed=1.0),))

    with pytest.raises(ValueError, match="positive"):
        timing_from_speed_keyframes(2.0, (SpeedKeyframe(time_seconds=1.0, before_speed=0.0, after_speed=1.0),))
