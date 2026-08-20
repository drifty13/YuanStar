from __future__ import annotations

import pytest


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_1_restore_empty_ui_test_app.py")
async def test_restore_entries_are_disabled_without_current_account_points(user) -> None:
    await user.open("/")
    import_entry = next(iter(user.find(marker="import-restore-snapshots").elements))
    assert import_entry._props.get("disable") is True
    await user.should_see("当前账号暂无可恢复快照")

    user.find("人工核对").click()
    review_entry = next(iter(user.find(marker="review-restore-snapshots").elements))
    assert review_entry._props.get("disable") is True
