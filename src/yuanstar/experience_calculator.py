"""Pure Phase 0.6 experience calculations with no file or UI dependencies."""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil
from typing import Iterable, Mapping

from .experience_rules import ExperienceRules


class ExperienceCalculationError(ValueError):
    pass


@dataclass(frozen=True)
class ExperienceStarRequirement:
    experience: int
    purple: int
    white: int


@dataclass(frozen=True)
class StageRequirement:
    runs: int
    stamina: int


@dataclass(frozen=True)
class InstanceExperiencePlan:
    star_instance_id: str
    current_level: int
    target_level: int


@dataclass(frozen=True)
class ExperiencePlanSummary:
    """One render-ready calculation for the currently applied filter scope."""

    planned_instance_count: int
    required: ExperienceStarRequirement
    remaining: ExperienceStarRequirement | None
    stage_6_24: StageRequirement | None
    calculation_warnings: tuple[str, ...]


def _validate_level(level: int, rules: ExperienceRules, *, label: str) -> None:
    if isinstance(level, bool) or not isinstance(level, int) or not 1 <= level <= rules.max_level:
        raise ExperienceCalculationError(f"{label}超出经验规则等级范围：{level}")


def raw_experience_required(current_level: int, target_level: int, rules: ExperienceRules) -> int:
    _validate_level(current_level, rules, label="当前等级")
    _validate_level(target_level, rules, label="计划等级")
    if current_level >= target_level:
        return 0
    return sum(rules.level_exp[level] for level in range(current_level, target_level))


def feedable_experience_required(current_level: int, target_level: int, rules: ExperienceRules) -> int:
    raw = raw_experience_required(current_level, target_level, rules)
    if raw == 0:
        return 0
    return ceil(raw / rules.round_exp_to) * rules.round_exp_to


def requirement_as_purple_white(experience: int, rules: ExperienceRules) -> ExperienceStarRequirement:
    if isinstance(experience, bool) or not isinstance(experience, int) or experience < 0:
        raise ExperienceCalculationError("经验需求必须为非负整数")
    if experience % rules.round_exp_to:
        raise ExperienceCalculationError(f"经验需求必须按{rules.round_exp_to}取整")
    purple, remainder = divmod(experience, rules.purple_exp)
    return ExperienceStarRequirement(experience=experience, purple=purple, white=remainder // rules.white_exp)


def owned_experience(orange: int, purple: int, white: int, rules: ExperienceRules) -> int:
    quantities = (("橙星曜", orange), ("紫星曜", purple), ("白星曜", white))
    for label, quantity in quantities:
        if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 0:
            raise ExperienceCalculationError(f"{label}数量必须为非负整数")
    orange_value = orange * rules.orange_exp if rules.include_orange_in_owned_exp else 0
    return orange_value + purple * rules.purple_exp + white * rules.white_exp


def remaining_gap(required_experience: int, owned_exp: int) -> int:
    if min(required_experience, owned_exp) < 0:
        raise ExperienceCalculationError("经验不能为负数")
    return max(0, required_experience - owned_exp)


def stage_6_24_requirement(gap_experience: int, rules: ExperienceRules) -> StageRequirement:
    if isinstance(gap_experience, bool) or not isinstance(gap_experience, int) or gap_experience < 0:
        raise ExperienceCalculationError("缺口经验必须为非负整数")
    if gap_experience == 0:
        return StageRequirement(runs=0, stamina=0)
    runs = ceil(gap_experience / rules.stage_6_24_exp_yield)
    return StageRequirement(runs=runs, stamina=runs * rules.stage_6_24_stamina_cost)


def feedable_experience_for_instances(
    plans: Iterable[InstanceExperiencePlan], rules: ExperienceRules
) -> tuple[int, int]:
    """Return (upgrading instance count, total) after per-instance rounding."""
    count = 0
    total = 0
    for plan in plans:
        required = feedable_experience_required(plan.current_level, plan.target_level, rules)
        if required:
            count += 1
            total += required
    return count, total


def summarize_experience_plan(
    plans: Iterable[InstanceExperiencePlan],
    rules: ExperienceRules,
    owned_quantities: Mapping[str, int | None],
) -> ExperiencePlanSummary:
    """Calculate B/C/D once from independently rounded filtered instances.

    Missing inventory deliberately leaves C/D unavailable rather than treating an
    unknown OCR count as zero. Invalid individual plans are reported and do not
    corrupt the valid instances in the same filtered scenario.
    """
    valid_plans: list[InstanceExperiencePlan] = []
    warnings: list[str] = []
    for plan in plans:
        try:
            feedable_experience_required(plan.current_level, plan.target_level, rules)
        except ExperienceCalculationError:
            warnings.append(f"实例 {plan.star_instance_id} 的等级超出经验规则范围")
        else:
            valid_plans.append(plan)
    count, total = feedable_experience_for_instances(valid_plans, rules)
    required = requirement_as_purple_white(total, rules)
    needed_names = ("橙星曜", "紫星曜", "白星曜")
    quantities = tuple(owned_quantities.get(name) for name in needed_names)
    if any(value is None for value in quantities):
        return ExperiencePlanSummary(
            planned_instance_count=count,
            required=required,
            remaining=None,
            stage_6_24=None,
            calculation_warnings=tuple(warnings),
        )
    try:
        owned = owned_experience(quantities[0], quantities[1], quantities[2], rules)  # type: ignore[arg-type]
    except ExperienceCalculationError:
        warnings.append("当前经验星曜数量无效，暂无法计算缺口")
        return ExperiencePlanSummary(
            planned_instance_count=count,
            required=required,
            remaining=None,
            stage_6_24=None,
            calculation_warnings=tuple(warnings),
        )
    gap = remaining_gap(total, owned)
    return ExperiencePlanSummary(
        planned_instance_count=count,
        required=required,
        remaining=requirement_as_purple_white(gap, rules),
        stage_6_24=stage_6_24_requirement(gap, rules),
        calculation_warnings=tuple(warnings),
    )
