from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
import re
from typing import Any, Literal, Mapping
from uuid import NAMESPACE_URL, uuid4, uuid5

from pydantic import BaseModel, Field, field_validator


class GameVersion(StrEnum):
    RU_YUAN = "如鸢"
    DAI_HAO_YUAN = "代号鸢"


class StarKind(StrEnum):
    MAIN = "主星"
    SUPPORT = "辅星"
    EXPERIENCE = "经验星石"


class Quality(StrEnum):
    ORANGE = "橙"
    PURPLE = "紫"
    BLUE = "蓝"
    GREEN = "绿"
    WHITE = "白"


class DetectedStarItem(BaseModel):
    """A local OCR card candidate retained for human review and provenance."""

    card_id: str | None = None
    source_image: str
    source_position: str | None = None
    row_crop_box: tuple[int, int, int, int] | None = None
    page_type: str = "unknown"
    recognized_name: str | None = None
    recognized_level: int | None = None
    recognized_quality: Quality | None = None
    final_name: str | None = None
    final_level: int | None = None
    final_quality: Quality | None = None
    equipped_state: Literal["not_evaluated", "equipped", "unequipped", "unknown"] = "not_evaluated"
    confidence: float | None = Field(default=None, ge=0, le=1)
    is_complete_card: bool = False
    field_warnings: list[str] = Field(default_factory=list)
    inventory_action: str = "keep"
    overlap_duplicate_of: str | None = None
    manual_override: bool = False


class InventorySummaryRow(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    kind: StarKind
    name: str
    level: int = Field(ge=1, le=60)
    quality: Quality = Quality.ORANGE
    quantity: int = Field(ge=1)
    equipped_state: Literal["not_evaluated", "equipped", "unequipped", "unknown"] = "not_evaluated"
    source_image: str | None = None
    source_position: str | None = None
    occurrence_id: str | None = None
    manual_status: str = "人工新增"
    upload_batch_index: int = Field(default=0, ge=0)
    source_image_index: int = Field(default=0, ge=0)
    row_index: int = Field(default=0, ge=0)
    column_index: int = Field(default=0, ge=0)

    @field_validator("kind")
    @classmethod
    def only_inventory_kinds(cls, value: StarKind) -> StarKind:
        if value == StarKind.EXPERIENCE:
            raise ValueError("经验星石不属于背包汇总行")
        return value

    @property
    def display_name(self) -> str:
        return display_name(self.name, self.quality)

    @property
    def star_instance_id(self) -> str:
        """Stable one-to-one identifier used by current and planned inventory rows."""
        return self.id


class WebInventoryRows(list[InventorySummaryRow]):
    """Marker for rows already ordered for the existing web inventory view."""

    def __init__(
        self,
        rows: list[InventorySummaryRow],
        *,
        filtered: bool,
    ) -> None:
        super().__init__(rows)
        self.filtered = filtered


class ExperienceResource(BaseModel):
    name: str
    quantity: int = Field(default=0, ge=0)
    experience_per_item: int | None = Field(default=None, ge=0)


class PlannedInventoryRow(BaseModel):
    """Phase 0.3 one-to-one plan skeleton; editing begins in a later phase."""

    star_instance_id: str
    placeholder: str = "后续养成计划将在此编辑"


class ImportBatch(BaseModel):
    imported_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    image_count: int = Field(ge=0)
    game_version: GameVersion
    bag_current_count: int | None = Field(default=None, ge=0)
    bag_capacity: int | None = Field(default=None, ge=0)
    ocr_executed: bool = False
    note: str = "当前版本尚未执行 OCR"


class ReconciliationStatus(StrEnum):
    MATCH = "数量一致"
    POSSIBLY_INCOMPLETE = "背包可能不完整，建议人工复查"
    POSSIBLY_DUPLICATED = "可能存在截图重复计数"
    NOT_PROVIDED = "未填写背包当前数量"


class ReconciliationResult(BaseModel):
    expected_count: int | None
    actual_count: int
    difference: int | None
    status: ReconciliationStatus
    warning: str | None = None
    message: str


def display_name(name: str, quality: Quality) -> str:
    return name if quality == Quality.ORANGE else f"{name}（{quality.value}）"


def inventory_total(rows: list[InventorySummaryRow]) -> int:
    return sum(row.quantity for row in rows if row.kind in {StarKind.MAIN, StarKind.SUPPORT})


def summary_key(row: InventorySummaryRow) -> tuple[StarKind, str, Quality, int]:
    return row.kind, row.name, row.quality, row.level


def summary_sort_key(row: InventorySummaryRow, catalog_order: Mapping[str, int]) -> tuple[int, int, str, int, int]:
    kind_order = {StarKind.MAIN: 0, StarKind.SUPPORT: 1}
    quality_order = {
        Quality.ORANGE: 0,
        Quality.PURPLE: 1,
        Quality.BLUE: 2,
        Quality.GREEN: 3,
        Quality.WHITE: 4,
    }
    return (
        kind_order[row.kind],
        catalog_order.get(row.name, len(catalog_order)),
        row.name,
        -row.level,
        quality_order[row.quality],
    )


def normalize_summary_rows(
    rows: list[InventorySummaryRow], catalog_order: Mapping[str, int]
) -> list[InventorySummaryRow]:
    """Merge identical summary keys, then apply the shared UI/Excel sort order."""
    merged: dict[tuple[StarKind, str, Quality, int], InventorySummaryRow] = {}
    for row in rows:
        key = summary_key(row)
        if key in merged:
            existing = merged[key]
            merged[key] = existing.model_copy(update={"quantity": existing.quantity + row.quantity})
        else:
            merged[key] = row.model_copy(deep=True)
    return sorted(merged.values(), key=lambda row: summary_sort_key(row, catalog_order))


def instance_sort_key(
    row: InventorySummaryRow,
    catalog_order: Mapping[str, int],
) -> tuple[object, ...]:
    """Authoritative default inventory/Excel sort without merging occurrences."""
    return _inventory_sort_key(row, catalog_order, filtered=False)


def web_inventory_group_key(
    row: InventorySummaryRow,
    *,
    filtered: bool,
) -> tuple[object, ...]:
    """Authoritative group key; category leads and equipped is always absent."""
    if filtered:
        return row.kind, row.name
    return row.kind, row.level, row.name, row.quality


def _inventory_stable_key(
    row: InventorySummaryRow,
) -> tuple[int, int, int, int, str, str]:
    return (
        row.upload_batch_index,
        row.source_image_index,
        row.row_index,
        row.column_index,
        row.occurrence_id or "",
        row.id,
    )


def _inventory_sort_key(
    row: InventorySummaryRow,
    catalog_order: Mapping[str, int],
    *,
    filtered: bool,
) -> tuple[object, ...]:
    """Return the sole comparator for default, filtered-web, and Excel rows."""
    kind_order = {StarKind.MAIN: 0, StarKind.SUPPORT: 1}
    quality_order = {
        Quality.ORANGE: 0,
        Quality.PURPLE: 1,
        Quality.BLUE: 2,
        Quality.GREEN: 3,
        Quality.WHITE: 4,
    }
    name_key = (catalog_order.get(row.name, len(catalog_order)), row.name)
    business_key = (
        (kind_order[row.kind], *name_key, -row.level, quality_order[row.quality])
        if filtered
        else (kind_order[row.kind], -row.level, *name_key, quality_order[row.quality])
    )
    return (*business_key, *_inventory_stable_key(row))


def web_inventory_sort_key(
    row: InventorySummaryRow,
    catalog_order: Mapping[str, int],
    *,
    filtered: bool,
) -> tuple[object, ...]:
    """Return the web comparator selected by the existing active-filter state."""
    return _inventory_sort_key(row, catalog_order, filtered=filtered)


def normalize_instance_rows(
    rows: list[InventorySummaryRow],
    catalog_order: Mapping[str, int],
) -> list[InventorySummaryRow]:
    """Expand requested quantities into individual physical instances and sort them."""
    instances: list[InventorySummaryRow] = []
    for row in rows:
        for index in range(row.quantity):
            instance_id = (
                row.id
                if index == 0
                else f"star_{uuid5(NAMESPACE_URL, f'{row.id}:{index}').hex}"
            )
            instances.append(row.model_copy(update={"id": instance_id, "quantity": 1}, deep=True))
    return sorted(instances, key=lambda row: instance_sort_key(row, catalog_order))


def parse_integer(
    value: int | str | None,
    *,
    label: str,
    minimum: int | None = None,
    maximum: int | None = None,
    allow_blank: bool = False,
    blank_value: int | None = None,
) -> int | None:
    """Parse user-entered integers without browser-side clipping or coercion."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if allow_blank:
            return blank_value
        raise ValueError(f"{label}不能为空。")
    if isinstance(value, bool):
        raise ValueError(f"{label}必须是整数。")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value.strip()):
        parsed = int(value.strip())
    else:
        raise ValueError(f"{label}必须是整数。")
    if minimum is not None and parsed < minimum:
        if maximum is not None:
            raise ValueError(f"{label}必须是 {minimum}–{maximum} 的整数。")
        raise ValueError(f"{label}必须是大于等于 {minimum} 的整数。")
    if maximum is not None and parsed > maximum:
        raise ValueError(f"{label}必须是 {minimum}–{maximum} 的整数。")
    return parsed


def reconciliation_message(result: ReconciliationResult) -> str:
    if result.status == ReconciliationStatus.NOT_PROVIDED:
        return f"当前汇总 {result.actual_count} 颗；尚未填写背包当前数量。"
    if result.status == ReconciliationStatus.MATCH:
        return f"当前汇总 {result.actual_count} 颗，与背包数量一致。"
    assert result.expected_count is not None and result.difference is not None
    amount = abs(result.difference)
    if result.difference < 0:
        return (
            f"当前汇总 {result.actual_count} 颗，背包数量 {result.expected_count} 颗，少 {amount} 颗。\n"
            "背包可能不完整，建议人工复查。\n"
            "数量不一致不会阻断保存或导出。"
        )
    return (
        f"当前汇总 {result.actual_count} 颗，背包数量 {result.expected_count} 颗，多 {amount} 颗。\n"
        "可能存在截图重复计数。\n"
        "数量不一致不会阻断保存或导出。"
    )


def reconcile(rows: list[InventorySummaryRow], expected_count: int | None) -> ReconciliationResult:
    actual_count = inventory_total(rows)
    if expected_count is None:
        result = ReconciliationResult(
            expected_count=None,
            actual_count=actual_count,
            difference=None,
            status=ReconciliationStatus.NOT_PROVIDED,
            message="",
        )
        return result.model_copy(update={"message": reconciliation_message(result)})
    difference = actual_count - expected_count
    if difference == 0:
        result = ReconciliationResult(
            expected_count=expected_count,
            actual_count=actual_count,
            difference=0,
            status=ReconciliationStatus.MATCH,
            message="",
        )
        return result.model_copy(update={"message": reconciliation_message(result)})
    if difference < 0:
        result = ReconciliationResult(
            expected_count=expected_count,
            actual_count=actual_count,
            difference=difference,
            status=ReconciliationStatus.POSSIBLY_INCOMPLETE,
            warning="数量不一致不会阻断保存或导出。",
            message="",
        )
        return result.model_copy(update={"message": reconciliation_message(result)})
    result = ReconciliationResult(
        expected_count=expected_count,
        actual_count=actual_count,
        difference=difference,
        status=ReconciliationStatus.POSSIBLY_DUPLICATED,
        warning="数量不一致不会阻断保存或导出。",
        message="",
    )
    return result.model_copy(update={"message": reconciliation_message(result)})


def model_copy_data(value: BaseModel) -> dict[str, Any]:
    """A JSON-safe deep-copy payload for the lightweight history stack."""
    return value.model_dump(mode="json")
