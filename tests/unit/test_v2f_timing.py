import pytest

from ymcp.tools.imagegen.timing import TimingMapSpec, TimingPoint, map_output_to_source, output_frame_source_indices, timing_preset


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
