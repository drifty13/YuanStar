from pathlib import Path


APP_SOURCE = (
    Path(__file__).resolve().parents[1] / "src" / "yuanstar" / "app.py"
).read_text(encoding="utf-8")


def test_phase0_6_experience_ui_uses_cached_rules_and_applied_filter_scope() -> None:
    assert "cached_experience_rules()" in APP_SOURCE
    assert "plans = [plan_for(row) for row in state.filtered_rows()]" in APP_SOURCE
    assert "summarize_experience_plan(plans, experience_rules, state.experience_quantities)" in APP_SOURCE
    assert APP_SOURCE.count("experience_section.refresh()") >= 5


def test_phase0_6_compact_copy_and_section_order() -> None:
    assert "当前经验星曜（不计入普通星石背包数量）" not in APP_SOURCE
    assert "计划消耗 / 未来状态" not in APP_SOURCE
    assert "数量不一致不会阻断保存或导出。" not in APP_SOURCE
    assert "最终唯一实例" not in APP_SOURCE
    assert "背包可能不完整，建议人工前往OCR模块复查。" in APP_SOURCE
    assert "OCR图片人工复核 | 待审查" in APP_SOURCE
    assert APP_SOURCE.index('section("experience", "经验星曜", default=True)') < APP_SOURCE.index(
        'section("ocr", ocr_title, default=False, caption=ocr_caption)'
    )


def test_phase0_6_result_rows_cover_a_through_c_and_degraded_states() -> None:
    for marker in (
        "experience-selected-plan",
        "experience-filter-plan",
        "experience-remaining-gap",
    ):
        assert marker in APP_SOURCE
    assert "experience-stage-6-24" not in APP_SOURCE
    assert "经验星曜规则加载失败，暂无法计算计划需求。" in APP_SOURCE
    assert "当前经验星曜数量未完整确认，暂无法计算缺口" in APP_SOURCE
    assert "按当前等级经验条0进度估算，实际需求可能更少。" in APP_SOURCE


def test_phase0_6_experience_rows_use_complete_copy_and_filter_scope() -> None:
    for copy in (
        "当前选中行",
        "请选择星石",
        "完成全部计划所需",
        "完成当前筛选所需",
        "共包含 {summary.planned_instance_count} 颗星石",
        "紫星曜 {requirement.purple} 颗    白星曜 {requirement.white} 颗",
        "紫星曜 {summary.required.purple} 颗    白星曜 {summary.required.white} 颗",
        "紫星曜 {summary.remaining.purple} 颗    白星曜 {summary.remaining.white} 颗",
        "需6-24 {summary.stage_6_24.runs}次",
    ):
        assert copy in APP_SOURCE
    assert "全账号库存抵扣" not in APP_SOURCE
    assert "grid-template-columns: repeat(3, minmax(0, 1fr));" in APP_SOURCE
    assert ".experience-plan-label { color: #1d2939; text-align: left; }" in APP_SOURCE
    assert ".experience-plan-value { color: #1d2939; text-align: center; overflow-wrap: anywhere; }" in APP_SOURCE
    assert "text-align: right" in APP_SOURCE
    assert "font-size" not in APP_SOURCE


def test_phase0_6_second_round_uses_compact_unweighted_three_column_rows() -> None:
    experience_css = APP_SOURCE[
        APP_SOURCE.index(".experience-column {") : APP_SOURCE.index(
            ".group-divider-cell"
        )
    ]
    assert "min-height" not in experience_css
    assert "grid-template-columns: repeat(3, minmax(0, 1fr));" in experience_css
    assert ".experience-plan-label { color: #1d2939; text-align: left; }" in experience_css
    assert ".experience-plan-value { color: #1d2939; text-align: center; overflow-wrap: anywhere; }" in experience_css
    assert "justify-self: stretch;" in experience_css
    assert "display: flex;" in experience_css
    assert "justify-content: flex-end;" in experience_css
    assert "text-align: right;" in experience_css
    assert "font-weight" not in experience_css

    experience_section = APP_SOURCE[APP_SOURCE.index("def experience_section()") : APP_SOURCE.index("def action_section()")]
    assert "experience-stage-6-24" not in experience_section
    assert "summary.stage_6_24.stamina" not in experience_section
    assert 'else f"需6-24 {summary.stage_6_24.runs}次"' in experience_section


def test_phase0_6_selection_refreshes_the_same_stable_instance() -> None:
    assert '"selected_experience_instance_id": None' in APP_SOURCE
    assert "def set_selected_experience_instance(instance_id: str | None)" in APP_SOURCE
    assert "selected_id = selected_experience_instance_id()" in APP_SOURCE
    assert APP_SOURCE.count("set_selected_experience_instance(") >= 8

    for handler in (
        "select_row",
        "select_clicked_row",
        "select_plan_row",
        "select_clicked_plan_row",
    ):
        start = APP_SOURCE.index(f"def {handler}(")
        end = APP_SOURCE.find("\n        def ", start + 1)
        handler_source = APP_SOURCE[start:end]
        assert "set_selected_experience_instance(" in handler_source
        assert "experience_section.refresh()" in handler_source
