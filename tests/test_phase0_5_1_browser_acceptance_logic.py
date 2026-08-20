from __future__ import annotations

from yuanstar.app import current_instance_display_position
from yuanstar.catalog import load_catalog
from yuanstar.domain import InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState


def make_state() -> tuple[SessionState, str, str]:
    state = SessionState(load_catalog())
    main_id = state.add_row(InventorySummaryRow(
        kind=StarKind.MAIN, name="天府", level=20, quality=Quality.ORANGE, quantity=1,
    ))
    support_id = state.add_row(InventorySummaryRow(
        kind=StarKind.SUPPORT, name="解神", level=20, quality=Quality.PURPLE, quantity=1,
    ))
    return state, main_id, support_id


def test_display_position_distinguishes_filter_exclusion_from_name_aggregation() -> None:
    state, main_id, _ = make_state()

    direct = current_instance_display_position(state, main_id)
    assert direct.exists is True
    assert direct.visible_after_filter is True
    assert direct.uniquely_addressable is True
    assert direct.display_index == 0

    state.set_filters(StarKind.SUPPORT.value, "全部", "")
    filtered_out = current_instance_display_position(state, main_id)
    assert filtered_out.exists is True
    assert filtered_out.visible_after_filter is False
    assert filtered_out.uniquely_addressable is False
    assert filtered_out.display_index is None

    state.set_filters("全部", "全部", "天府")
    aggregated = current_instance_display_position(state, main_id)
    assert aggregated.exists is True
    assert aggregated.visible_after_filter is True
    assert aggregated.uniquely_addressable is False
    assert aggregated.display_index is None


def test_display_position_handles_quality_and_name_filter_exclusion() -> None:
    state, main_id, _ = make_state()

    state.set_filters("全部", Quality.PURPLE.value, "")
    assert current_instance_display_position(state, main_id).visible_after_filter is False

    state.set_filters("全部", "全部", "解神")
    assert current_instance_display_position(state, main_id).visible_after_filter is False
