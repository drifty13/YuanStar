from yuanstar.catalog import load_catalog
from yuanstar.domain import InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState


def row(name: str, *, kind: StarKind = StarKind.MAIN, level: int = 1, quality: Quality = Quality.ORANGE, quantity: int = 1) -> InventorySummaryRow:
    return InventorySummaryRow(kind=kind, name=name, level=level, quality=quality, quantity=quantity)


def test_exact_duplicate_creates_independent_physical_instances() -> None:
    state = SessionState(load_catalog())
    state.add_row(row("天府", level=10, quantity=2))
    state.add_row(row("天府", level=10, quantity=3))
    assert len(state.rows) == 5
    assert all(item.quantity == 1 for item in state.rows)
    assert len({item.star_instance_id for item in state.rows}) == 5


def test_different_level_and_quality_do_not_merge_and_levels_descend() -> None:
    state = SessionState(load_catalog())
    state.add_row(row("天府", level=5))
    state.add_row(row("天府", level=20))
    state.add_row(row("天府", level=20, quality=Quality.PURPLE))
    assert [(item.level, item.quality) for item in state.rows] == [
        (20, Quality.ORANGE),
        (20, Quality.PURPLE),
        (5, Quality.ORANGE),
    ]


def test_update_collision_keeps_instances_and_undo_redo_restore_both_states() -> None:
    state = SessionState(load_catalog())
    first = state.add_row(row("天府", level=10, quantity=2))
    second = state.add_row(row("天府", level=20, quantity=3))
    state.update_row(second, row("天府", level=10, quantity=3))
    assert len(state.rows) == 7
    assert first in {item.id for item in state.rows}
    assert second in {item.id for item in state.rows}
    assert state.selected_row_id == second
    assert all(item.quantity == 1 for item in state.rows)
    assert state.undo()
    assert [item.level for item in state.rows] == [20, 20, 20, 10, 10]
    assert state.redo()
    assert len(state.rows) == 7
    assert [item.level for item in state.rows] == [20, 20, 10, 10, 10, 10, 10]


def test_catalog_order_places_main_before_support_and_same_name_adjacent() -> None:
    state = SessionState(load_catalog())
    state.add_row(row("解神", kind=StarKind.SUPPORT))
    state.add_row(row("破军", level=1))
    state.add_row(row("天府", level=1))
    assert [(item.kind, item.name) for item in state.rows] == [
        (StarKind.MAIN, "天府"),
        (StarKind.MAIN, "破军"),
        (StarKind.SUPPORT, "解神"),
    ]
