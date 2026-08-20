from __future__ import annotations

import asyncio

import pytest


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_4_save_failure_ui_test_app.py")
async def test_save_failure_blocks_account_switch(user) -> None:
    await user.open("/")
    selector = user.find(marker="account-selector")
    selector_element = next(iter(selector.elements))
    target_id = next(
        option["value"]
        for option in selector_element._props["options"]
        if option["label"] == "代号鸢 · 保存失败目标"
    )

    selector.trigger(
        "update:modelValue",
        {"value": target_id, "label": "代号鸢 · 保存失败目标"},
    )
    await asyncio.sleep(.25)
    name = next(iter(user.find(marker="workspace-account-name").elements))
    assert name.value == "默认账号"
    await user.should_see("当前账号保存失败，未切换账号")
