import pytest
from pydantic import ValidationError

from ymcp.contracts.common import Handoff, HandoffOption


def test_handoff_recommended_action_must_be_in_options():
    with pytest.raises(ValidationError):
        Handoff(
            recommended_next_action='missing',
            options=[
                HandoffOption(
                    value='yplan',
                    title='进入 yplan',
                    description='继续',
                )
            ],
        )


def test_handoff_derives_allowed_next_actions_from_options():
    handoff = Handoff(
        recommended_next_action='yplan',
        options=[
            HandoffOption(
                value='yplan',
                title='进入 yplan',
                description='继续',
                recommended=True,
            )
        ],
    )
    assert handoff.allowed_next_actions == ['yplan']
