from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest


def event_type(element, fragment: str) -> str:
    return next(
        listener.type for listener in element._event_listeners.values()
        if fragment.lower() in listener.type.lower()
    )


def editor_outside_event(user) -> tuple[object, str]:
    editor_fields = next(iter(user.find(marker="manual-editor-fields").elements))
    editor_token = next(iter(user.find(marker="manual-kind-select").elements))._props.get(
        "data-yuanstar-editor-token"
    )
    assert isinstance(editor_token, str) and editor_token
    return editor_token, event_type(editor_fields, "outside")


def invoke_custom_listener(element, fragment: str, args: object = None) -> None:
    listener = next(
        listener for listener in element._event_listeners.values()
        if fragment.lower() in listener.type.lower() and listener.args is None
    )
    listener.handler(SimpleNamespace(args=args))


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_plan_change_reloads_existing_table_elements_in_place(user) -> None:
    await user.open("/")
    user.find("人工核对").click()

    current = user.find(marker="current-inventory-table")
    planned = user.find(marker="planned-inventory-table")
    current_table = next(iter(current.elements))
    planned_table = next(iter(planned.elements))
    current_table_id = current_table.id
    planned_table_id = planned_table.id
    planned_row = next(row for row in planned_table._props["rows"] if row["level"] < 60)

    planned.trigger("selection", {"added": True, "rows": [planned_row], "keys": []})
    await user.should_see("正在编辑：计划背包实例")
    user.find(marker="plan-level-60").click()
    await asyncio.sleep(.1)

    current_after = next(iter(user.find(marker="current-inventory-table").elements))
    planned_after = next(iter(user.find(marker="planned-inventory-table").elements))
    assert current_after.id == current_table_id
    assert planned_after.id == planned_table_id
    assert next(
        row for row in planned_after._props["rows"]
        if row["star_instance_id"] == planned_row["star_instance_id"]
    )["level"] == 60
    assert planned_after._props["selected"][0]["star_instance_id"] == planned_row["star_instance_id"]
    assert current_after._props["selected"] == []


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_selection_and_undo_keep_existing_table_elements(user) -> None:
    await user.open("/")
    user.find("人工核对").click()

    current = user.find(marker="current-inventory-table")
    planned = user.find(marker="planned-inventory-table")
    current_table = next(iter(current.elements))
    planned_table = next(iter(planned.elements))
    current_table_id = current_table.id
    planned_table_id = planned_table.id
    planned_row = next(row for row in planned_table._props["rows"] if row["level"] < 60)

    planned.trigger("selection", {"added": True, "rows": [planned_row], "keys": []})
    await user.should_see("正在编辑：计划背包实例")
    user.find(marker="plan-level-60").click()
    await asyncio.sleep(.1)
    user.find(marker="undo-action").click()
    await asyncio.sleep(.1)
    user.find(marker="redo-action").click()
    await asyncio.sleep(.1)

    assert next(iter(user.find(marker="current-inventory-table").elements)).id == current_table_id
    assert next(iter(user.find(marker="planned-inventory-table").elements)).id == planned_table_id


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_current_row_update_reloads_existing_table_elements_in_place(user) -> None:
    await user.open("/")
    user.find("人工核对").click()

    current = user.find(marker="current-inventory-table")
    planned = user.find(marker="planned-inventory-table")
    current_table = next(iter(current.elements))
    planned_table = next(iter(planned.elements))
    current_table_id = current_table.id
    planned_table_id = planned_table.id
    current_row = next(
        row for index, row in enumerate(current_table._props["rows"])
        if row["kind"] == "主星" and index > 5 and row["level"] < 60
    )
    old_index = next(index for index, row in enumerate(current_table._props["rows"]) if row["id"] == current_row["id"])
    scroll_calls: list[tuple[str, int]] = []
    current_table.run_method = lambda method, index, edge: scroll_calls.append((f"current:{method}:{edge}", index))
    planned_table.run_method = lambda method, index, edge: scroll_calls.append((f"planned:{method}:{edge}", index))

    current.trigger("selection", {"added": True, "rows": [current_row], "keys": []})
    await user.should_see("正在编辑：当前背包实例")
    await asyncio.sleep(.1)
    assert current_table._props["selected"][0]["id"] == current_row["id"]
    await user.should_not_see("更新选中行")

    level_interaction = user.find(marker="manual-level-input")
    assert len(level_interaction.elements) == 1
    level_input = next(iter(level_interaction.elements))
    assert level_input.value == str(current_row["level"])
    keydown_listener = next(listener for listener in level_input._event_listeners.values() if listener.type == "keydown")
    new_level = 60
    level_input.value = str(new_level)
    assert level_input.value == str(new_level)
    level_interaction.trigger("update:value", str(new_level))
    level_interaction.trigger("keydown", {"key": "Enter", "isComposing": False})
    await asyncio.sleep(.1)

    current_after = next(iter(user.find(marker="current-inventory-table").elements))
    planned_after = next(iter(user.find(marker="planned-inventory-table").elements))
    assert current_after.id == current_table_id
    assert planned_after.id == planned_table_id
    assert next(row for row in current_after._props["rows"] if row["id"] == current_row["id"])["level"] == new_level
    assert next(
        row for row in planned_after._props["rows"]
        if row["star_instance_id"] == current_row["star_instance_id"]
    )["level"] == new_level
    assert current_after._props["selected"][0]["id"] == current_row["id"]
    assert planned_after._props["selected"] == []
    assert next(
        row for row in current_after._props["rows"] if row["id"] == current_row["id"]
    )["row_highlight"] == "actual"
    assert next(
        row for row in planned_after._props["rows"]
        if row["star_instance_id"] == current_row["star_instance_id"]
    )["row_highlight"] == "counterpart"
    new_index = next(index for index, row in enumerate(current_after._props["rows"]) if row["id"] == current_row["id"])
    assert new_index != old_index
    assert new_index == 0
    assert scroll_calls == [
        ("current:scrollTo:start", 0),
        ("planned:scrollTo:start", 0),
    ]


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_current_row_follow_scrolls_one_row_before_a_nonzero_target(user) -> None:
    await user.open("/")
    user.find("人工核对").click()

    current = user.find(marker="current-inventory-table")
    planned = user.find(marker="planned-inventory-table")
    current_table = next(iter(current.elements))
    planned_table = next(iter(planned.elements))
    current_table_id = current_table.id
    planned_table_id = planned_table.id
    current_row = next(
        row for index, row in enumerate(current_table._props["rows"])
        if row["kind"] == "主星" and index > 8 and row["level"] != 47
    )
    old_index = next(index for index, row in enumerate(current_table._props["rows"]) if row["id"] == current_row["id"])
    scroll_calls: list[tuple[str, int]] = []
    current_table.run_method = lambda method, index, edge: scroll_calls.append((f"current:{method}:{edge}", index))
    planned_table.run_method = lambda method, index, edge: scroll_calls.append((f"planned:{method}:{edge}", index))

    current.trigger("selection", {"added": True, "rows": [current_row], "keys": []})
    await user.should_see("正在编辑：当前背包实例")
    await asyncio.sleep(.1)
    level = user.find(marker="manual-level-input")
    level_input = next(iter(level.elements))
    level_input.value = "47"
    level.trigger("update:value", "47")
    level.trigger("keydown", {"key": "Enter", "isComposing": False})
    await asyncio.sleep(.1)

    current_after = next(iter(user.find(marker="current-inventory-table").elements))
    planned_after = next(iter(user.find(marker="planned-inventory-table").elements))
    target_index = next(index for index, row in enumerate(current_after._props["rows"]) if row["id"] == current_row["id"])
    scroll_index = target_index - 1
    assert target_index > 0
    assert target_index != old_index
    assert current_after.id == current_table_id
    assert planned_after.id == planned_table_id
    assert scroll_calls == [
        ("current:scrollTo:start", scroll_index),
        ("planned:scrollTo:start", scroll_index),
    ]
    assert current_after._props["selected"][0]["id"] == current_row["id"]
    assert planned_after._props["selected"] == []
    assert current_after._props["rows"][target_index]["row_highlight"] == "actual"
    assert planned_after._props["rows"][target_index]["row_highlight"] == "counterpart"
    assert current_after._props["rows"][scroll_index]["id"] != current_row["id"]
    assert current_after._props["rows"][scroll_index]["row_highlight"] != "actual"


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_current_editor_commits_once_after_leaving_field_group(user) -> None:
    await user.open("/")
    user.find("人工核对").click()

    current = user.find(marker="current-inventory-table")
    current_table = next(iter(current.elements))
    current_row = next(row for row in current_table._props["rows"] if row["level"] < 58)
    current.trigger("selection", {"added": True, "rows": [current_row], "keys": []})
    await asyncio.sleep(.1)

    level = user.find(marker="manual-level-input")
    level_input = next(iter(level.elements))
    updated_level = current_row["level"] + 1
    level_input.value = str(updated_level)
    level.trigger("update:value", str(updated_level))
    editor_token, outside_event_type = editor_outside_event(user)
    user.find(marker="manual-editor-fields").trigger(
        outside_event_type, {"token": editor_token}
    )
    await asyncio.sleep(.1)
    user.find(marker="manual-editor-fields").trigger(
        outside_event_type, {"token": editor_token}
    )
    await asyncio.sleep(.1)

    updated_table = next(iter(user.find(marker="current-inventory-table").elements))
    assert next(row for row in updated_table._props["rows"] if row["id"] == current_row["id"])["level"] == updated_level
    assert next(iter(user.find(marker="current-save-status").elements)).text == "已自动保存"


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_select_popup_keeps_current_editor_draft_until_real_outside_click(user) -> None:
    await user.open("/")
    user.find("人工核对").click()
    current = user.find(marker="current-inventory-table")
    current_table = next(iter(current.elements))
    current_row = next(row for row in current_table._props["rows"] if row["kind"] == "主星")
    current.trigger("selection", {"added": True, "rows": [current_row], "keys": []})
    await asyncio.sleep(.1)

    level = user.find(marker="manual-level-input")
    level_input = next(iter(level.elements))
    level_input.value = str(current_row["level"] + 1)
    level.trigger("update:value", level_input.value)
    name = user.find(marker="manual-name-select")
    name_input = next(iter(name.elements))
    name.trigger(event_type(name_input, "popupshow"))
    alternative_name = next(option for option in name_input.options if option != current_row["name"])
    name_input.value = alternative_name
    invoke_custom_listener(name_input, "modelvalue", alternative_name)
    name.trigger(event_type(name_input, "popuphide"))
    await asyncio.sleep(.1)

    assert next(row for row in current_table._props["rows"] if row["id"] == current_row["id"])["level"] == current_row["level"]
    assert next(row for row in current_table._props["rows"] if row["id"] == current_row["id"])["name"] == current_row["name"]

    editor_token, outside_event_type = editor_outside_event(user)
    user.find(marker="manual-editor-fields").trigger(outside_event_type, {"token": editor_token})
    await asyncio.sleep(.1)
    current_after = next(iter(user.find(marker="current-inventory-table").elements))
    saved = next(row for row in current_after._props["rows"] if row["id"] == current_row["id"])
    assert saved["level"] == current_row["level"] + 1
    assert saved["name"] == alternative_name


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_filter_exclusion_clears_selection_and_replaces_editor_with_notice(user) -> None:
    await user.open("/")
    user.find("人工核对").click()
    kind_filter = next(iter(user.find(marker="kind-filter").elements))
    kind_filter.value = "主星"
    user.find(marker="apply-filters").click()
    await asyncio.sleep(.1)

    current = user.find(marker="current-inventory-table")
    planned = user.find(marker="planned-inventory-table")
    current_table = next(iter(current.elements))
    planned_table = next(iter(planned.elements))
    current_table_id = current_table.id
    planned_table_id = planned_table.id
    current_row = current_table._props["rows"][0]
    current.trigger("selection", {"added": True, "rows": [current_row], "keys": []})
    await asyncio.sleep(.1)

    kind = user.find(marker="manual-kind-select")
    kind_input = next(iter(kind.elements))
    kind_input.value = "辅星"
    invoke_custom_listener(kind_input, "modelvalue", "辅星")
    editor_token, outside_event_type = editor_outside_event(user)
    user.find(marker="manual-editor-fields").trigger(outside_event_type, {"token": editor_token})
    await asyncio.sleep(.1)

    current_after = next(iter(user.find(marker="current-inventory-table").elements))
    planned_after = next(iter(user.find(marker="planned-inventory-table").elements))
    assert current_after.id == current_table_id
    assert planned_after.id == planned_table_id
    assert all(row["id"] != current_row["id"] for row in current_after._props["rows"])
    assert all(row["star_instance_id"] != current_row["star_instance_id"] for row in planned_after._props["rows"])
    assert current_after._props["selected"] == []
    assert planned_after._props["selected"] == []
    await user.should_see("该实例已更新，但不再符合当前筛选条件。")
    await user.should_see("正在新增：当前背包")
    assert next(iter(user.find(marker="manual-level-input").elements)).value == "1"
    quantity = next(element for element in user.find("新增颗数").elements if hasattr(element, "enabled"))
    assert quantity.enabled is True
    assert user.notify.contains("该实例已更新，但不再符合当前筛选条件。")


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_selecting_another_current_row_commits_the_old_dirty_session_first(user) -> None:
    await user.open("/")
    user.find("人工核对").click()
    current = user.find(marker="current-inventory-table")
    current_table = next(iter(current.elements))
    original = current_table._props["rows"][0]
    next_row = current_table._props["rows"][1]
    current.trigger("selection", {"added": True, "rows": [original], "keys": []})
    await asyncio.sleep(.1)

    level = user.find(marker="manual-level-input")
    level_input = next(iter(level.elements))
    level_input.value = str(original["level"] + 1)
    level.trigger("update:value", level_input.value)
    current.trigger("selection", {"added": True, "rows": [next_row], "keys": []})
    await asyncio.sleep(.15)

    current_after = next(iter(user.find(marker="current-inventory-table").elements))
    assert next(row for row in current_after._props["rows"] if row["id"] == original["id"])["level"] == original["level"] + 1
    assert current_after._props["selected"][0]["id"] == next_row["id"]
    await user.should_see(f"正在编辑：当前背包实例 {next_row['star_instance_id']}")


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_5_viewport_in_place_test_app.py")
async def test_invalid_draft_blocks_switching_to_another_current_row(user) -> None:
    await user.open("/")
    user.find("人工核对").click()
    current = user.find(marker="current-inventory-table")
    current_table = next(iter(current.elements))
    original = current_table._props["rows"][0]
    next_row = current_table._props["rows"][1]
    current.trigger("selection", {"added": True, "rows": [original], "keys": []})
    await asyncio.sleep(.1)

    level = user.find(marker="manual-level-input")
    level_input = next(iter(level.elements))
    level_input.value = "invalid"
    level.trigger("update:value", "invalid")
    current.trigger("selection", {"added": True, "rows": [next_row], "keys": []})
    await asyncio.sleep(.1)

    assert current_table._props["selected"][0]["id"] == original["id"]
    await user.should_see(f"正在编辑：当前背包实例 {original['star_instance_id']}")
    assert user.notify.contains("等级")
