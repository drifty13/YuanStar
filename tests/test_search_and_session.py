import pytest

from yuanstar.catalog import load_catalog
from yuanstar.domain import GameVersion, InventorySummaryRow, Quality, StarKind, reconcile
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput


def row(name: str, *, kind: StarKind, quality: Quality = Quality.ORANGE, level: int = 1, quantity: int = 1) -> InventorySummaryRow:
    return InventorySummaryRow(kind=kind, name=name, quality=quality, level=level, quantity=quantity)


def test_alias_and_multiple_name_search_with_filters() -> None:
    state = SessionState(load_catalog())
    state.add_row(row("紫微", kind=StarKind.MAIN))
    state.add_row(row("天府", kind=StarKind.MAIN, quality=Quality.PURPLE))
    state.add_row(row("破军", kind=StarKind.MAIN))
    state.add_row(row("解神", kind=StarKind.SUPPORT))
    state.set_filters("全部", "全部", "紫薇")
    assert [item.name for item in state.filtered_rows()] == ["紫微"]
    state.set_filters("全部", "全部", "天府 破军")
    assert [item.name for item in state.filtered_rows()] == ["天府", "破军"]
    state.set_filters("全部", "全部", "天府，解神")
    assert [item.name for item in state.filtered_rows()] == ["天府", "解神"]
    state.set_filters("主星", "紫", "天府 破军")
    assert [item.name for item in state.filtered_rows()] == ["天府"]


def test_bag_info_update_preserves_rows_and_is_undoable() -> None:
    state = SessionState(load_catalog())
    state.add_row(row("天府", kind=StarKind.MAIN, quantity=2))
    state.save_experience(3, 4)
    state.save_bag_info(GameVersion.DAI_HAO_YUAN, "8", "250")
    assert state.game_version == GameVersion.DAI_HAO_YUAN
    assert state.bag_current_count == 8
    assert state.bag_capacity == 250
    assert len(state.rows) == 2
    assert all(item.quantity == 1 for item in state.rows)
    assert state.experience_quantities == {"橙星曜": None, "紫星曜": 3, "白星曜": 4}
    assert state.import_batch is not None and state.import_batch.image_count == 0
    assert state.undo()
    assert state.bag_current_count is None
    assert len(state.rows) == 2
    assert all(item.quantity == 1 for item in state.rows)
    assert state.redo()
    assert state.bag_current_count == 8


@pytest.mark.parametrize("count,capacity", [("-1", "250"), ("1.5", "250"), ("1", "0")])
def test_invalid_bag_info_does_not_change_state_or_history(count: str, capacity: str) -> None:
    state = SessionState(load_catalog())
    before = state.snapshot()
    with pytest.raises(ValueError):
        state.save_bag_info(GameVersion.RU_YUAN, count, capacity)
    assert state.snapshot() == before
    assert not state.history.can_undo


def test_no_image_import_does_not_clear_data_or_record_history() -> None:
    state = SessionState(load_catalog())
    state.add_row(row("天府", kind=StarKind.MAIN))
    state.history = state.history.__class__(max_steps=30)
    before = state.snapshot()
    with pytest.raises(ValueError, match="请先上传至少一张截图"):
        state.start_import(GameVersion.RU_YUAN, "1", "250")
    assert state.snapshot() == before
    assert not state.history.can_undo


def test_uploaded_images_can_be_cleared() -> None:
    state = SessionState(load_catalog())
    state.uploaded_images.append(ImageInput(filename="one.png", width=100, height=100))
    state.clear_uploaded_images()
    assert state.uploaded_images == []


def test_reconciliation_messages_cover_all_states() -> None:
    rows = [row("天府", kind=StarKind.MAIN, quantity=11)]
    assert "少 2 颗" in reconcile(rows, 13).message
    assert "与背包数量一致" in reconcile(rows, 11).message
    assert "多 1 颗" in reconcile(rows, 10).message
    assert "尚未填写背包当前数量" in reconcile(rows, None).message
