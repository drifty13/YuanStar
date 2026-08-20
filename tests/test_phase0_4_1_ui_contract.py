from __future__ import annotations

from pathlib import Path


APP_SOURCE = Path("src/yuanstar/app.py").read_text(encoding="utf-8")


def test_account_management_grid_and_editable_version_contract() -> None:
    assert ".account-management-grid" in APP_SOURCE
    assert "grid-template-columns: minmax(0, 1.25fr) repeat(4, minmax(0, 1fr));" in APP_SOURCE
    assert "gap: .75rem;" in APP_SOURCE
    assert 'f"{account.game_version.value} · {account.display_name}"' in APP_SOURCE
    assert '"创建并进入" if account_ui_state["creating"] else "新增账号"' in APP_SOURCE
    assert 'ui.button("删除当前账号").props("disable").tooltip("暂未开放").mark("delete-account-placeholder")' in APP_SOURCE
    assert 'if account_ui_state["creating"]:' in APP_SOURCE
    assert 'label="游戏版本",\n                    ).mark("import-game-version")' in APP_SOURCE
    assert 'label="游戏版本",\n                        ).props("dense").mark("bag-game-version")' in APP_SOURCE
    assert 'account_name.on("blur", save_account_metadata)' in APP_SOURCE
    assert 'account_name.on("keydown.enter", save_account_metadata)' in APP_SOURCE
    assert 'metadata_account.on("blur", save_metadata_from_bag)' in APP_SOURCE
    assert 'metadata_account.on("keydown.enter", save_metadata_from_bag)' in APP_SOURCE
    assert "await update_current_account_metadata(" in APP_SOURCE
    assert "game_version.on_value_change(save_account_metadata)" in APP_SOURCE
    assert "metadata_version.on_value_change(save_metadata_from_bag)" in APP_SOURCE


def test_overlap_and_one_time_viewport_alignment_contract() -> None:
    alignment_block = APP_SOURCE.split("def align_counterpart_view_once", 1)[1].split("def select_row", 1)[0]
    assert "padding: .5rem 1rem .75rem 1.25rem !important;" in APP_SOURCE
    assert "gap: .35rem !important;" in APP_SOURCE
    assert "def align_counterpart_view_once" in APP_SOURCE
    assert ".q-table__middle" in APP_SOURCE
    assert "requestAnimationFrame(() => requestAnimationFrame(align))" in APP_SOURCE
    assert "sourceMiddle.scrollTop" in APP_SOURCE
    assert "targetMiddle.scrollTop" in APP_SOURCE
    assert "__yuanstarInventoryAlignToken" in APP_SOURCE
    assert "rowBox.top - middleBox.top" not in APP_SOURCE
    assert "data-star-instance-id" not in APP_SOURCE
    assert "scrollIntoView" not in alignment_block
    assert 'addEventListener("scroll"' not in alignment_block
