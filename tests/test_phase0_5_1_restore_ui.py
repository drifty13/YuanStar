from __future__ import annotations

import pytest


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_1_restore_ui_test_app.py")
async def test_restore_entries_share_a_card_dialog_and_execute_without_confirmation(user) -> None:
    await user.open("/")
    await user.should_see(marker="import-restore-snapshots")
    import_entry = next(iter(user.find(marker="import-restore-snapshots").elements))
    assert import_entry._props.get("disable") is not True

    user.find(marker="import-restore-snapshots").click()
    await user.should_see(marker="restore-snapshots-dialog")
    await user.should_see(marker="restore-point-card")
    card = next(iter(user.find(marker="restore-point-card").elements))
    assert card._props.get("model-value") is False
    user.find(marker="restore-dialog-close").click()

    user.find("人工核对").click()
    await user.should_see(marker="review-restore-snapshots")
    user.find(marker="review-restore-snapshots").click()
    await user.should_see(marker="restore-snapshots-dialog")

    user.find(marker="restore-point-card").trigger("click")
    await user.should_see(marker="restore-this-snapshot")
    user.find(marker="restore-this-snapshot").click()
    await user.should_see("已恢复到", retries=30)
