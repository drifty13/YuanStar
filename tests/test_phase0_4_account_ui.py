from __future__ import annotations

import asyncio

import pytest


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_4_account_ui_test_app.py")
async def test_local_account_controls_and_switch_reset_are_available(user) -> None:
    await user.open("/")
    await user.should_see(marker="account-selector")
    await user.should_see(marker="create-account")
    await user.should_see(marker="delete-account-placeholder")
    delete_placeholder = next(iter(user.find(marker="delete-account-placeholder").elements))
    assert delete_placeholder._props.get("disable") is True
    version = next(iter(user.find(marker="import-game-version").elements))
    assert version._props.get("readonly") is not True

    selector = user.find(marker="account-selector")
    selector_element = next(iter(selector.elements))
    second_account_id = next(
        option["value"]
        for option in selector_element._props["options"]
        if option["label"] == "代号鸢 · 第二账号"
    )
    selector.trigger(
        "update:modelValue",
        {"value": second_account_id, "label": "代号鸢 · 第二账号"},
    )
    await asyncio.sleep(.25)
    name = next(iter(user.find(marker="workspace-account-name").elements))
    assert name.value == "第二账号"
    current = next(iter(user.find(marker="bag-game-version").elements))
    assert current._props.get("readonly") is not True

    selected_version = current.value
    next_version = "如鸢" if selected_version == "代号鸢" else "代号鸢"
    user.find(marker="import-game-version").trigger(
        "update:modelValue",
        {"value": 0 if next_version == "如鸢" else 1, "label": next_version},
    )
    await asyncio.sleep(.2)
    assert next(iter(user.find(marker="bag-game-version").elements)).value == next_version

    restored_version = "如鸢" if next_version == "代号鸢" else "代号鸢"
    user.find(marker="bag-game-version").trigger(
        "update:modelValue",
        {"value": 0 if restored_version == "如鸢" else 1, "label": restored_version},
    )
    await asyncio.sleep(.2)
    assert next(iter(user.find(marker="import-game-version").elements)).value == restored_version

    user.find(marker="create-account").click()
    await asyncio.sleep(.1)
    create_button = next(iter(user.find(marker="create-account").elements))
    assert create_button._props["label"] == "创建并进入"
    draft_name = next(iter(user.find(marker="workspace-account-name").elements))
    assert draft_name.value == ""
    draft_version = next(iter(user.find(marker="import-game-version").elements))
    assert draft_version._props.get("readonly") is not True

    draft_selector = user.find(marker="account-selector")
    draft_selector.trigger(
        "update:modelValue",
        {"value": second_account_id, "label": "代号鸢 · 第二账号"},
    )
    await asyncio.sleep(.2)
    assert next(iter(user.find(marker="create-account").elements))._props["label"] == "新增账号"
