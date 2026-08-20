from pathlib import Path


def test_row_highlights_are_visual_only_and_keep_real_selection_separate() -> None:
    source = Path("src/yuanstar/app.py").read_text(encoding="utf-8")

    assert "data-yuanstar-row-highlight" in source
    assert '"actual" if row["id"] == current_row_id' in source
    assert '"actual" if row["star_instance_id"] == plan_row_id' in source
    assert '"counterpart" if row["star_instance_id"] == selected_plan_instance_id' in source
    assert '"counterpart" if row["star_instance_id"] == selected_current_instance_id' in source
    assert "refresh_row_visual_state" in source
    assert "table.selected = []" in source
    assert "plan_table.selected = []" in source
    assert "table.selected = [selected_current_row] if selected_current_row is not None else []" in source
    assert "plan_table.selected = [selected_plan_row] if selected_plan_row is not None else []" in source
    assert "row = dict(source_row)" in source
    assert "table.rows = current_rows_for_ui" in source
    assert "plan_table.rows = planned_rows_for_ui" in source
    assert 'tr:has(> td[data-yuanstar-row-highlight="actual"]) > td' in source
    assert 'tr:has(> td[data-yuanstar-row-highlight="counterpart"]) > td' in source
    assert "td.yuanstar-selected-row" not in source
    assert "td.yuanstar-counterpart-row" not in source
    assert "background-color: #c6cbd2 !important;" in source
    assert "background-color: #e9edf1 !important;" in source


def test_tooltip_is_catalog_driven_and_scoped_to_the_name_text() -> None:
    source = Path("src/yuanstar/app.py").read_text(encoding="utf-8")

    assert 'catalog.description(str(row["name"]))' in source
    assert source.count('class="star-description-trigger"') == 2
    assert source.count('class="star-description-tooltip"') == 2
    assert "padding-inline: 1em;" in source
    assert "white-space: pre-line;" in source
    assert "margin-inline" not in source
    assert "白值攻击力" not in source
