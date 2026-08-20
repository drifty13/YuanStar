import pytest
from pydantic import ValidationError

from yuanstar.catalog import load_catalog
from yuanstar.domain import InventorySummaryRow, StarKind, parse_integer
from yuanstar.session import SessionState


@pytest.mark.parametrize("value", ["0", "-1", "61", "1.5", "abc"])
def test_level_requires_integer_in_range(value: str) -> None:
    with pytest.raises(ValueError):
        parse_integer(value, label="等级", minimum=1, maximum=60)


@pytest.mark.parametrize("value", ["0", "-1"])
def test_inventory_quantity_requires_at_least_one(value: str) -> None:
    with pytest.raises(ValueError):
        parse_integer(value, label="数量", minimum=1)


def test_model_rejects_zero_inventory_quantity() -> None:
    with pytest.raises(ValidationError):
        InventorySummaryRow(kind=StarKind.MAIN, name="天府", level=1, quantity=0)


def test_invalid_experience_does_not_change_state_or_history() -> None:
    state = SessionState(load_catalog())
    before = state.snapshot()
    with pytest.raises(ValueError):
        state.save_experience("-1", "0")
    assert state.snapshot() == before
    assert not state.history.can_undo


def test_blank_experience_is_explicitly_saved_as_unknown() -> None:
    state = SessionState(load_catalog())
    state.save_experience("", "")
    assert state.experience_quantities == {"橙星曜": None, "紫星曜": None, "白星曜": None}
    assert state.history.can_undo
