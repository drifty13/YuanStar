from __future__ import annotations

from collections.abc import Iterable
import json
import re
from typing import Any

from .domain import InventorySummaryRow, WebInventoryRows, web_inventory_group_key


POOL_ORDER = ("main", "support", "experience")
REVIEW_SECTION_DEFAULTS = {
    "inventory": True,
    "editor": True,
    "ocr": False,
    "experience": True,
}
POOL_LABELS = {
    "main": "主星池",
    "support": "辅星池",
    "experience": "经验星石池",
    "unknown": "待确认池",
}
STATUS_LABELS = {
    "main": "主星",
    "support": "辅星",
    "experience": "经验星石",
    "pending": "待审查",
    "accepted": "完整",
    "excluded": "已排除",
    "overlap duplicate": "重叠重复",
    "unknown": "未识别",
    "idle": "等待开始",
    "running": "识别中",
    "succeeded": "已完成",
    "failed": "失败，可重试",
    "manual": "人工值",
    "consistent": "一致",
    "conflict": "冲突，需人工确认",
    "not_evaluated": "未评估",
}

WARNING_LABELS = {
    "name_unknown": "名称未知",
    "level_unknown": "等级未知",
    "rarity_unknown": "品质未知",
    "quality_unknown": "品质未知",
    "incomplete_card": "卡片残缺",
    "no_recognized_star_for_candidate": "未识别到有效星石",
    "bag_count_unknown": "背包数量未知",
    "bag_count_unavailable": "背包数量未知",
    "card_detection_empty": "未检测到星石卡片",
    "black_bar_detection_rejected": "截图边缘识别不可靠",
    "level_order_conflict": "等级顺序需要人工复核",
    "hierarchical_level_order_conflict": "等级顺序需要人工复核",
    "level_inferred_by_sort_order": "等级依据页面顺序推断",
    "level_inferred_by_hierarchical_order": "等级依据页面层级推断",
    "name_inferred_by_sort_sandwich": "名称依据相邻卡片推断",
    "name_inferred_by_hierarchical_sandwich": "名称依据相邻卡片推断",
    "manual_overlap_value_conflict": "同一重叠组存在冲突的人工值，已暂停合并",
    "auto_excluded_edge_fragment_top": "截图上边缘等级带截断，已自动排除",
    "auto_excluded_edge_fragment_bottom": "截图下边缘名称带截断，已自动排除",
    "experience_icon_unclassified": "存在未分类的经验星曜图标",
    "semantic_fields_pending_or_unknown": "星石字段仍需人工复核",
    "insufficient_semantic_identity": "可用于重叠判断的信息不足",
    "explicit_card_visual_conflict": "卡片画面不一致",
    "synthetic_fixture_warning": "测试图片提示",
}


def localized_status(value: object) -> str:
    if value is None:
        return STATUS_LABELS["unknown"]
    text = str(value)
    if text in STATUS_LABELS:
        return STATUS_LABELS[text]
    if re.fullmatch(r"[a-z0-9_ -]+", text):
        return "需要人工复核"
    return text


def localized_position(value: object) -> str:
    if value is None:
        return "位置未识别"
    text = str(value)
    match = re.fullmatch(r"r(\d+)c(\d+)", text)
    if match:
        return f"第{match.group(1)}行第{match.group(2)}列"
    return "位置需要人工复核"


def localized_warning(value: object) -> str:
    """Translate display warnings without leaking unknown internal snake_case."""
    if value is None:
        return "需要人工复核"
    text = str(value).strip()
    if not text:
        return "需要人工复核"
    if text in WARNING_LABELS:
        return WARNING_LABELS[text]
    if ":" in text:
        prefix, suffix = text.split(":", 1)
        column = re.fullmatch(r"c(\d+)", prefix)
        translated = WARNING_LABELS.get(suffix)
        if column and translated:
            return f"第{column.group(1)}列：{translated}"
    if re.fullmatch(r"[a-z0-9_:/.-]+", text):
        return "需要人工复核"
    return text


def item_needs_review(item: Any) -> bool:
    return bool(
        item.inventory_action == "keep"
        and not (
            item.is_complete_card
            and item.final_name
            and item.final_level
            and item.final_quality
        )
    )


def pending_review_count(items: Iterable[Any]) -> int:
    return sum(item_needs_review(item) for item in items)


def can_confirm_all_pools(
    images: Iterable[Any],
    image_pools: dict[str, str],
    confirmed_image_pools: set[str],
    *,
    processing: bool,
) -> bool:
    """Enable bulk confirmation only when all uploaded images are classified."""
    if processing:
        return False
    visible = list(images)
    # Keep the action available after the final manual confirmation as a
    # harmless idempotent operation; this also makes the state transition
    # immediately visible without a page reload.
    _ = confirmed_image_pools
    return bool(visible) and all(
        image_pools.get(image.id, "unknown") in POOL_ORDER
        for image in visible
    )


def restored_review_section_states(raw: object) -> dict[str, bool]:
    """Validate browser-local expansion state and safely apply defaults."""
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else {}
    except (TypeError, ValueError):
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    return {
        name: parsed.get(name) if isinstance(parsed.get(name), bool) else default
        for name, default in REVIEW_SECTION_DEFAULTS.items()
    }


def inventory_display_rows(
    rows: Iterable[InventorySummaryRow],
    *,
    aggregate_by_name: bool = False,
) -> list[dict[str, object]]:
    """Build one visible row per physical instance with group counts on first rows."""
    web_ordered = isinstance(rows, WebInventoryRows)
    filtered_group = (
        rows.filtered
        if web_ordered
        else aggregate_by_name
    )
    visible = list(rows)
    totals: dict[tuple[object, ...], int] = {}
    for row in visible:
        key = web_inventory_group_key(row, filtered=filtered_group)
        totals[key] = totals.get(key, 0) + 1
    previous_key: tuple[object, ...] | None = None
    previous_kind: object | None = None
    previous_name: str | None = None
    result: list[dict[str, object]] = []
    for row in visible:
        key = web_inventory_group_key(row, filtered=filtered_group)
        result.append({
            "id": row.id,
            "star_instance_id": row.star_instance_id,
            "kind": row.kind.value,
            "name": row.name,
            "level": row.level,
            "quality": row.quality.value,
            "group_quantity": (
                f"本组共 {totals[key]} 颗"
                if key != previous_key
                else ""
            ),
            "group_start": key != previous_key,
            "kind_start": previous_kind is not None and row.kind != previous_kind,
            "name_group_start": aggregate_by_name and (
                previous_kind != row.kind or row.name != previous_name
            ),
            "source_image": row.source_image,
            "source_position": row.source_position,
            "occurrence_id": row.occurrence_id,
            "manual_status": row.manual_status,
        })
        previous_key = key
        previous_kind = row.kind
        previous_name = row.name
    return result


def plan_display_rows(
    rows: Iterable[InventorySummaryRow],
    plan_targets: dict[str, int] | None = None,
    *,
    aggregate_by_name: bool = False,
) -> list[dict[str, object]]:
    """Overlay plan levels without creating a second inventory or sort order."""
    web_ordered = isinstance(rows, WebInventoryRows)
    filtered_group = (
        rows.filtered
        if web_ordered
        else aggregate_by_name
    )
    result: list[dict[str, object]] = []
    previous_key: tuple[object, ...] | None = None
    previous_kind: object | None = None
    visible = list(rows)
    totals: dict[tuple[object, ...], int] = {}
    for row in visible:
        key = web_inventory_group_key(row, filtered=filtered_group)
        totals[key] = totals.get(key, 0) + 1
    previous_name: str | None = None
    for row in visible:
        planned = (plan_targets or {}).get(row.star_instance_id)
        planned_level = planned if isinstance(planned, int) else row.level
        key = web_inventory_group_key(row, filtered=filtered_group)
        result.append({
            "star_instance_id": row.star_instance_id,
            "kind": row.kind.value,
            "name": row.name,
            "level": planned_level,
            "current_level": row.level,
            "plan_level": planned_level,
            "quality": row.quality.value,
            "group_quantity": (
                f"本组共 {totals[key]} 颗"
                if key != previous_key
                else ""
            ),
            "group_start": key != previous_key,
            "kind_start": previous_kind is not None and row.kind != previous_kind,
            "name_group_start": aggregate_by_name and (
                previous_kind != row.kind or row.name != previous_name
            ),
            "placeholder": getattr(planned, "placeholder", "后续养成计划将在此编辑"),
        })
        previous_key = key
        previous_kind = row.kind
        previous_name = row.name
    return result


def review_counts(items: Iterable[Any], unique_instance_count: int) -> dict[str, int]:
    candidates = list(items)
    fully_resolved = sum(bool(
        item.is_complete_card
        and item.inventory_action == "keep"
        and item.final_name
        and item.final_level
        and item.final_quality
    ) for item in candidates)
    excluded = sum(item.inventory_action != "keep" for item in candidates)
    duplicates = sum(
        item.inventory_action == "keep" and item.overlap_duplicate_of is not None
        for item in candidates
    )
    return {
        "detected_occurrence_count": len(candidates),
        "fully_resolved_count": fully_resolved,
        "excluded_count": excluded,
        "overlap_duplicate_count": duplicates,
        "unique_instance_count": unique_instance_count,
    }


def review_image_summaries(state: Any) -> list[dict[str, object]]:
    summaries: list[dict[str, object]] = []
    for image_index, image in enumerate(state.uploaded_images):
        audit = state.image_audit.get(image.id, {})
        image_items = [item for item in state.detected_items if item.source_image == image.id]
        if not audit and not image_items:
            continue
        pending = pending_review_count(image_items)
        excluded = sum(item.inventory_action != "keep" for item in image_items)
        duplicates = sum(
            item.inventory_action == "keep" and item.overlap_duplicate_of is not None
            for item in image_items
        )
        warnings = [str(item) for item in audit.get("warnings", [])]
        for field in ("bag_warning",):
            if audit.get(field):
                warnings.append(str(audit[field]))
        experience = audit.get("experience")
        if isinstance(experience, dict) and experience.get("warning"):
            warnings.append(str(experience["warning"]))
        page_type = str(audit.get("page_type") or state.image_pools.get(image.id, "unknown"))
        summaries.append({
            "image_id": image.id,
            "image_index": image_index,
            "filename": image.filename,
            "page_type": page_type,
            "page_type_label": localized_status(page_type),
            "detected_occurrence_count": len(image_items),
            "pending_count": pending,
            "excluded_count": excluded,
            "overlap_duplicate_count": duplicates,
            "warnings": warnings,
            "preview_data_url": audit.get("preview_data_url"),
            "experience": experience,
            "bag_current_count": audit.get("bag_current_count"),
            "bag_capacity": audit.get("bag_capacity"),
            "bag_confidence": audit.get("bag_confidence"),
        })
    return sorted(
        summaries,
        key=lambda item: (
            0 if item["pending_count"] else 1,
            0 if item["warnings"] else 1,
            item["image_index"],
        ),
    )
