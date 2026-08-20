from pathlib import Path


APP_SOURCE = (
    Path(__file__).resolve().parents[1] / "src" / "yuanstar" / "app.py"
).read_text(encoding="utf-8")


def test_compacted_layout_keeps_equal_inventory_windows_and_editor_boundaries() -> None:
    assert ".review-column { min-width: 0; height: 28.5rem;" in APP_SOURCE
    assert ".review-column .inventory-table .q-table__container," in APP_SOURCE
    assert ".manual-editor-section {" in APP_SOURCE
    assert "padding-bottom: .1rem;" in APP_SOURCE
    assert ".manual-editor-content {" in APP_SOURCE
    assert "display: flex; flex-direction: column; gap: .5rem;" in APP_SOURCE
    assert "padding-top: 0;" in APP_SOURCE
    assert "margin-top: -16px;" in APP_SOURCE
    assert 'section("editor", "人工新增与编辑", default=True).classes("manual-editor-section")' in APP_SOURCE
    assert 'mark("manual-editor-status")' in APP_SOURCE
    assert 'mark("manual-editor-fields")' in APP_SOURCE
    assert 'mark("manual-editor-actions")' in APP_SOURCE
    assert 'mark("manual-editor-content")' in APP_SOURCE
    assert "后续养成计划将在此编辑" not in APP_SOURCE


def test_inventory_tables_keep_the_existing_shared_density_contract() -> None:
    table_props = '"dense flat bordered hide-bottom virtual-scroll wrap-cells"'
    assert APP_SOURCE.count(table_props) == 2
    assert "tbody tr {" not in APP_SOURCE
    assert "td { padding" not in APP_SOURCE
    assert "th { padding" not in APP_SOURCE
    assert "font-size" not in APP_SOURCE


def test_experience_fields_and_actions_have_stable_three_column_contract() -> None:
    assert "grid-template-columns: repeat(3, minmax(0, 1fr));" in APP_SOURCE
    assert ".experience-field-stack { min-width: 0; }" in APP_SOURCE
    assert ".experience-column { min-width: 0; padding: .6rem; overflow: visible; }" in APP_SOURCE
    assert ".experience-action-row {" in APP_SOURCE
    assert "justify-content: space-between;" in APP_SOURCE
    assert 'mark("experience-quantity-fields")' in APP_SOURCE
    assert 'mark("experience-action-row")' in APP_SOURCE
    assert APP_SOURCE.index('mark("experience-original-preview")') < APP_SOURCE.index(
        'mark("save-experience")'
    )
