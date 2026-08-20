from __future__ import annotations

import pytest


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_1_restore_problem_ui_test_app.py")
async def test_missing_images_warn_but_unreadable_card_has_no_restore_button(user) -> None:
    await user.open("/")
    user.find(marker="import-restore-snapshots").click()
    await user.should_see("可恢复，但有 1 张原图缺失")
    await user.should_see("不可读取")
    # Exactly one card is structurally readable, so the corrupt card cannot
    # offer a second restore action while the missing-image card remains usable.
    assert len(user.find(marker="restore-this-snapshot").elements) == 1
