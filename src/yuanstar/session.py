from __future__ import annotations

from copy import deepcopy
import re
from uuid import uuid4

from .catalog import StarCatalog
from .domain import (
    GameVersion,
    DetectedStarItem,
    ImportBatch,
    InventorySummaryRow,
    PlannedInventoryRow,
    Quality,
    StarKind,
    WebInventoryRows,
    normalize_instance_rows,
    parse_integer,
    web_inventory_group_key,
    web_inventory_sort_key,
)
from .history import SessionHistory
from .vision.contracts import ImageInput
from .vision.contracts import AnalysisResult


class SessionState:
    """In-memory MVP0 state with validated mutations and snapshot history."""

    def __init__(self, catalog: StarCatalog) -> None:
        self.catalog = catalog
        self.game_version = GameVersion.RU_YUAN
        self.account_name = ""
        self.uploaded_images: list[ImageInput] = []
        self.bag_current_count: int | None = None
        self.bag_capacity: int | None = None
        self.rows: list[InventorySummaryRow] = []
        # Plans are deliberately a lightweight overlay.  Current-inventory
        # instances remain the sole owner of every business field except the
        # optional future level.
        self.plan_targets: dict[str, int] = {}
        self.experience_quantities: dict[str, int | None] = {
            "橙星曜": None,
            "紫星曜": None,
            "白星曜": None,
        }
        self.experience_evidence: dict[str, dict[str, object]] = {}
        self.experience_manual_fields: set[str] = set()
        self.bag_resolution: dict[str, object] = {}
        self.bag_manual_fields: set[str] = set()
        self.import_batch: ImportBatch | None = None
        self.history: SessionHistory[dict] = SessionHistory(max_steps=30)
        self.filter_kind = "全部"
        self.filter_quality = "全部"
        self.filter_name = ""
        self.selected_row_id: str | None = None
        self.image_pools: dict[str, str] = {}
        self.confirmed_image_pools: set[str] = set()
        self.overlap_pairs: dict[str, list[tuple[str, str]]] = {"main": [], "support": []}
        self.overlap_audit: list[dict[str, object]] = []
        self.detected_items: list[DetectedStarItem] = []
        self.image_audit: dict[str, dict[str, object]] = {}
        self.selected_import_image_id: str | None = None
        self.postprocess_revision = 0
        self.pending_full_batch_replacement = False

    def snapshot(self) -> dict:
        return {
            "game_version": self.game_version.value,
            "account_name": self.account_name,
            # Pending screenshots are session-local inputs, not undo history.
            # Keep only small metadata in a snapshot so image bytes are never copied.
            "uploaded_image_metadata": [
                {
                    "id": image.id,
                    "filename": image.filename,
                    "width": image.width,
                    "height": image.height,
                    "size_bytes": image.size_bytes,
                    "content_type": image.content_type,
                }
                for image in self.uploaded_images
            ],
            "bag_current_count": self.bag_current_count,
            "bag_capacity": self.bag_capacity,
            "rows": [row.model_dump(mode="json") for row in self.rows],
            "plan_targets": deepcopy(self.plan_targets),
            "experience_quantities": deepcopy(self.experience_quantities),
            "experience_evidence": deepcopy(self.experience_evidence),
            "experience_manual_fields": sorted(self.experience_manual_fields),
            "bag_resolution": deepcopy(self.bag_resolution),
            "bag_manual_fields": sorted(self.bag_manual_fields),
            "import_batch": self.import_batch.model_dump(mode="json") if self.import_batch else None,
            "image_pools": deepcopy(self.image_pools),
            "confirmed_image_pools": sorted(self.confirmed_image_pools),
            "overlap_pairs": deepcopy(self.overlap_pairs),
            "overlap_audit": deepcopy(self.overlap_audit),
            "detected_items": [item.model_dump(mode="json") for item in self.detected_items],
            "image_audit": deepcopy(self.image_audit),
            "postprocess_revision": self.postprocess_revision,
            "pending_full_batch_replacement": self.pending_full_batch_replacement,
        }

    def restore(self, snapshot: dict) -> None:
        self.game_version = GameVersion(
            snapshot.get("game_version", GameVersion.RU_YUAN.value)
        )
        self.account_name = str(snapshot.get("account_name") or "")
        history_images = snapshot.get("history_uploaded_images")
        if isinstance(history_images, list):
            self.uploaded_images = deepcopy(history_images)
        self.bag_current_count = snapshot["bag_current_count"]
        self.bag_capacity = snapshot["bag_capacity"]
        self.rows = normalize_instance_rows(
            [InventorySummaryRow.model_validate(row) for row in snapshot["rows"]], self.catalog.order_index
        )
        raw_targets = snapshot.get("plan_targets", {})
        # Phase 0.4 stored only skeleton rows.  Reading it is safe, but it
        # never becomes a second copy of inventory data.
        self.plan_targets = {
            str(key): int(value)
            for key, value in raw_targets.items()
            if isinstance(value, int) and 1 <= value <= 60
        } if isinstance(raw_targets, dict) else {}
        self._sync_plan_targets()
        self.experience_quantities = deepcopy(snapshot["experience_quantities"])
        self.experience_evidence = deepcopy(snapshot.get("experience_evidence", {}))
        self.experience_manual_fields = set(snapshot.get("experience_manual_fields", []))
        self.bag_resolution = deepcopy(snapshot.get("bag_resolution", {}))
        self.bag_manual_fields = set(snapshot.get("bag_manual_fields", []))
        self.import_batch = ImportBatch.model_validate(snapshot["import_batch"]) if snapshot["import_batch"] else None
        self.image_pools = deepcopy(snapshot.get("image_pools", {}))
        self.confirmed_image_pools = set(snapshot.get("confirmed_image_pools", []))
        raw_pairs = snapshot.get("overlap_pairs", {"main": [], "support": []})
        self.overlap_pairs = {
            pool: [
                (str(pair[0]), str(pair[1]))
                for pair in raw_pairs.get(pool, [])
                if isinstance(pair, (list, tuple)) and len(pair) == 2
            ]
            for pool in ("main", "support")
        }
        self.overlap_audit = deepcopy(snapshot.get("overlap_audit", []))
        self.detected_items = [DetectedStarItem.model_validate(item) for item in snapshot.get("detected_items", [])]
        self.image_audit = deepcopy(snapshot.get("image_audit", {}))
        self.postprocess_revision = int(snapshot.get("postprocess_revision", 0))
        self.pending_full_batch_replacement = bool(
            snapshot.get("pending_full_batch_replacement", False)
        )
        self.selected_row_id = None

    def reset_transient_ui_state(self) -> None:
        """Reset UI-only state after a disk restore without touching business data."""
        self.filter_kind = "全部"
        self.filter_quality = "全部"
        self.filter_name = ""
        self.selected_row_id = None
        self.selected_import_image_id = None
        self.history = SessionHistory(max_steps=30)

    def _record(self) -> None:
        self.history.record(self.snapshot())

    def _record_full_workspace(self) -> None:
        """Record the image-bearing state for a destructive OCR replacement."""
        snapshot = self.snapshot()
        snapshot["history_uploaded_images"] = deepcopy(self.uploaded_images)
        self.history.record(snapshot)

    def _normalize_rows(self) -> None:
        self.rows = normalize_instance_rows(self.rows, self.catalog.order_index)
        self._sync_plan_targets()

    def _sync_plan_targets(self) -> None:
        """Drop stale targets and repair targets below their current levels."""
        current_by_id = {row.star_instance_id: row.level for row in self.rows}
        self.plan_targets = {
            instance_id: max(level, current_by_id[instance_id])
            for instance_id, level in self.plan_targets.items()
            if instance_id in current_by_id and 1 <= level <= 60
        }

    def plan_level(self, star_instance_id: str) -> int:
        row = next((item for item in self.rows if item.star_instance_id == star_instance_id), None)
        if row is None:
            raise ValueError("未找到对应的当前背包实例")
        return self.plan_targets.get(star_instance_id, row.level)

    @property
    def plan_rows(self) -> dict[str, PlannedInventoryRow]:
        """Compatibility view for Phase 0.4 callers; it is never persisted."""
        return {row.star_instance_id: PlannedInventoryRow(star_instance_id=row.star_instance_id) for row in self.rows}

    @plan_rows.setter
    def plan_rows(self, _value: object) -> None:
        # Legacy callers used assignment only to clear a read-only skeleton.
        # The Phase 0.5 durable state remains the level-only mapping.
        self.plan_targets = {}

    def _set_plan_level_no_record(self, star_instance_id: str, level: int) -> bool:
        row = next((item for item in self.rows if item.star_instance_id == star_instance_id), None)
        if row is None:
            raise ValueError("未找到对应的当前背包实例")
        if not 1 <= level <= 60:
            raise ValueError("计划等级必须是 1–60 的整数")
        if level < row.level:
            raise ValueError(f"计划等级不能低于当前等级 {row.level}")
        previous = self.plan_level(star_instance_id)
        if level == row.level:
            self.plan_targets.pop(star_instance_id, None)
        else:
            self.plan_targets[star_instance_id] = level
        return previous != level

    def set_plan_level(self, star_instance_id: str, value: int | str) -> bool:
        level = parse_integer(value, label="计划等级", minimum=1, maximum=60)
        row = next((item for item in self.rows if item.star_instance_id == star_instance_id), None)
        if row is None:
            raise ValueError("未找到对应的当前背包实例")
        if level < row.level:
            raise ValueError(f"计划等级不能低于当前等级 {row.level}")
        if self.plan_level(star_instance_id) == level:
            return False
        self._record()
        return self._set_plan_level_no_record(star_instance_id, level)

    def correct_current_and_plan_level(self, star_instance_id: str, value: int | str) -> bool:
        """Apply the low-target confirmation outcome as one atomic history step."""
        level = parse_integer(value, label="计划等级", minimum=1, maximum=60)
        index = next((i for i, item in enumerate(self.rows) if item.star_instance_id == star_instance_id), None)
        if index is None:
            raise ValueError("未找到对应的当前背包实例")
        row = self.rows[index]
        if level >= row.level:
            return self.set_plan_level(star_instance_id, level)
        self._record()
        detected_index = next(
            (
                candidate_index
                for candidate_index, item in enumerate(self.detected_items)
                if item.card_id and item.card_id == row.occurrence_id
            ),
            None,
        )
        if detected_index is not None:
            self.detected_items[detected_index] = self.detected_items[detected_index].model_copy(update={
                "final_level": level,
                "manual_override": True,
                "inventory_action": "keep",
            })
            # Rebuilding consumes the manual OCR value, so later overlap
            # recalculation cannot resurrect the old recognized level.
            self.recalculate_postprocess()
        else:
            self.rows[index] = row.model_copy(update={"level": level, "manual_status": "人工修改"})
        self.plan_targets.pop(star_instance_id, None)
        self._normalize_rows()
        self.selected_row_id = star_instance_id
        return True

    def restore_plan_to_current(self, star_instance_id: str) -> bool:
        row = next((item for item in self.rows if item.star_instance_id == star_instance_id), None)
        if row is None:
            raise ValueError("未找到对应的当前背包实例")
        return self.set_plan_level(star_instance_id, row.level)

    def plan_level_60(self, star_instance_id: str) -> bool:
        row = next((item for item in self.rows if item.star_instance_id == star_instance_id), None)
        if row is None:
            raise ValueError("未找到对应的当前背包实例")
        if row.level == 60:
            return False
        return self.set_plan_level(star_instance_id, 60)

    def reset_all_plan_targets(self) -> bool:
        if not any(self.plan_level(row.star_instance_id) > row.level for row in self.rows):
            return False
        self._record()
        self.plan_targets = {}
        return True

    def _validate_row(self, row: InventorySummaryRow) -> None:
        entry = self.catalog.entry(row.name)
        if entry.kind != row.kind:
            raise ValueError("所选星石与大类不一致")

    def add_row(self, row: InventorySummaryRow) -> str:
        self._validate_row(row)
        self._record()
        additions = normalize_instance_rows([row], self.catalog.order_index)
        self.rows.extend(additions)
        self._normalize_rows()
        self.postprocess_revision += 1
        self.selected_row_id = additions[0].id
        return additions[0].id

    def update_row(self, row_id: str, replacement: InventorySummaryRow) -> str:
        self._validate_row(replacement)
        index = next((index for index, row in enumerate(self.rows) if row.id == row_id), None)
        if index is None:
            raise ValueError("未找到需要修改的星石实例")
        current = self.rows[index]
        detected_index = next(
            (
                detected_index
                for detected_index, item in enumerate(self.detected_items)
                if item.card_id and item.card_id == current.occurrence_id
            ),
            None,
        )
        self._record()
        if detected_index is not None:
            self.detected_items[detected_index] = self.detected_items[detected_index].model_copy(update={
                "final_name": replacement.name,
                "final_level": replacement.level,
                "final_quality": replacement.quality,
                "manual_override": True,
                "inventory_action": "keep",
            })
            self.recalculate_postprocess()
        else:
            replacements = normalize_instance_rows([replacement], self.catalog.order_index)
            replacements[0] = replacements[0].model_copy(update={"id": row_id})
            self.rows[index:index + 1] = replacements
            self._normalize_rows()
            self.postprocess_revision += 1
        self.selected_row_id = row_id
        return row_id

    def delete_row(self, row_id: str) -> None:
        if not any(row.id == row_id for row in self.rows):
            raise ValueError("未找到需要删除的星石实例")
        current = next(row for row in self.rows if row.id == row_id)
        detected_index = next(
            (
                detected_index
                for detected_index, item in enumerate(self.detected_items)
                if item.card_id and item.card_id == current.occurrence_id
            ),
            None,
        )
        self._record()
        if detected_index is not None:
            self.detected_items[detected_index] = self.detected_items[detected_index].model_copy(
                update={"inventory_action": "exclude_false_box"}
            )
            self.recalculate_postprocess()
        else:
            self.rows = [row for row in self.rows if row.id != row_id]
            self._sync_plan_targets()
            self.postprocess_revision += 1
        self.selected_row_id = None

    def clear_rows(self) -> None:
        self._record()
        self.rows = []
        self.plan_targets = {}
        self.selected_row_id = None
        self.postprocess_revision += 1

    def start_import(
        self,
        game_version: GameVersion | str,
        bag_current_count: int | str | None,
        bag_capacity: int | str | None,
    ) -> ImportBatch:
        if not self.uploaded_images:
            raise ValueError("请先上传至少一张截图")
        parsed_count = parse_integer(
            bag_current_count, label="背包当前数量", minimum=0, allow_blank=True, blank_value=None
        )
        parsed_capacity = parse_integer(
            bag_capacity, label="背包容量", minimum=1, allow_blank=True, blank_value=None
        )
        # This is a non-destructive preparation step.  The old session is
        # replaced only after a successful AnalysisResult is applied.
        return ImportBatch(
            image_count=len(self.uploaded_images),
            game_version=GameVersion(game_version),
            bag_current_count=parsed_count,
            bag_capacity=parsed_capacity,
        )

    def clear_uploaded_images(self) -> None:
        """Clear the active image batch and every value derived from that batch."""
        self.pending_full_batch_replacement = True
        self.uploaded_images = []
        self.image_pools = {}
        self.confirmed_image_pools = set()
        self.overlap_pairs = {"main": [], "support": []}
        self.overlap_audit = []
        self.selected_import_image_id = None
        self.bag_current_count = None
        self.bag_capacity = None
        self.bag_resolution = {}
        self.bag_manual_fields = set()
        self.rows = []
        self.plan_targets = {}
        self.detected_items = []
        self.image_audit = {}
        self.import_batch = None
        self.experience_quantities = {
            "橙星曜": None,
            "紫星曜": None,
            "白星曜": None,
        }
        self.experience_evidence = {}
        self.experience_manual_fields = set()
        self.selected_row_id = None
        self.postprocess_revision += 1

    def apply_local_analysis(self, result: AnalysisResult, *, rebuild_inventory: bool = False) -> int:
        """Replace the editable summary only with complete, usable local OCR items."""
        if not result.executed:
            return 0
        full_replacement = rebuild_inventory or self.pending_full_batch_replacement
        self._record_full_workspace() if full_replacement else self._record()
        manual_bag_current = self.bag_current_count
        manual_bag_capacity = self.bag_capacity
        previous_manual_items = {
            item.card_id: item
            for item in self.detected_items
            if item.card_id and item.manual_override
        }
        incoming_items: list[DetectedStarItem] = []
        for item in result.items:
            incoming = item.model_copy(deep=True)
            previous = previous_manual_items.get(item.card_id)
            if previous is not None and not full_replacement:
                incoming = incoming.model_copy(update={
                    "final_name": previous.final_name,
                    "final_level": previous.final_level,
                    "final_quality": previous.final_quality,
                    "manual_override": True,
                })
            incoming_items.append(incoming)
        self.detected_items = incoming_items
        self.rows = (
            []
            if full_replacement
            else [
                row.model_copy(deep=True)
                for row in self.rows
                if row.manual_status in {"人工新增", "人工修改"}
                and row.occurrence_id is None
            ]
        )
        self.plan_targets = {}
        if full_replacement:
            self.bag_current_count = None
            self.bag_capacity = None
            self.bag_resolution = {}
            self.bag_manual_fields = set()
            self.experience_quantities = {
                "橙星曜": None,
                "紫星曜": None,
                "白星曜": None,
            }
            self.experience_evidence = {}
            self.experience_manual_fields = set()
        self.recalculate_postprocess()
        self.import_batch = result.import_batch
        if result.import_batch:
            self.game_version = result.import_batch.game_version
            if full_replacement or "bag_current_count" not in self.bag_manual_fields:
                self.bag_current_count = result.import_batch.bag_current_count
            if full_replacement or "bag_capacity" not in self.bag_manual_fields:
                self.bag_capacity = result.import_batch.bag_capacity
            if self.bag_manual_fields and not full_replacement:
                self.bag_current_count = (
                    manual_bag_current
                    if "bag_current_count" in self.bag_manual_fields
                    else self.bag_current_count
                )
                self.bag_capacity = (
                    manual_bag_capacity
                    if "bag_capacity" in self.bag_manual_fields
                    else self.bag_capacity
                )
                self.import_batch = result.import_batch.model_copy(update={
                    "bag_current_count": self.bag_current_count,
                    "bag_capacity": self.bag_capacity,
                })
        self.bag_resolution = deepcopy(getattr(result, "bag_resolution", {}))
        experience_resolution = getattr(result, "experience_resolution", {})
        self.experience_evidence = deepcopy(experience_resolution)
        for name in ("橙星曜", "紫星曜", "白星曜"):
            if full_replacement or name not in self.experience_manual_fields:
                field = experience_resolution.get(name, {})
                self.experience_quantities[name] = field.get("value") if isinstance(field, dict) else None
        self.image_pools = {
            image_id: self.image_pools.get(image_id, pool) if image_id in self.confirmed_image_pools else pool
            for image_id, pool in result.image_pools.items()
        }
        self.image_audit = deepcopy(result.image_audit)
        self.overlap_audit = deepcopy(getattr(result, "overlap_audit", []))
        self.confirmed_image_pools.intersection_update(result.image_pools)
        self.pending_full_batch_replacement = False
        self.selected_row_id = None
        return sum(bool(
            item.is_complete_card and item.final_name and item.final_level and item.final_quality
            and item.inventory_action == "keep" and item.overlap_duplicate_of is None
        ) for item in self.detected_items)

    def _rebuild_rows_from_detected(self) -> None:
        detected_card_ids = {item.card_id for item in self.detected_items if item.card_id}
        existing_ids_by_occurrence = {
            row.occurrence_id: row.id
            for row in self.rows
            if row.occurrence_id
        }
        rows: list[InventorySummaryRow] = [
            row.model_copy(deep=True)
            for row in self.rows
            if row.manual_status in {"人工新增", "人工修改"}
            and (row.occurrence_id is None or row.occurrence_id not in detected_card_ids)
        ]
        source_indexes = {image.id: index for index, image in enumerate(self.uploaded_images)}
        for item in self.detected_items:
            if not (
                item.is_complete_card and item.final_name and item.final_level and item.final_quality
                and item.inventory_action == "keep" and item.overlap_duplicate_of is None
            ):
                continue
            entry = self.catalog.entry(item.final_name)
            if entry.kind == StarKind.EXPERIENCE:
                continue
            occurrence_id = item.card_id or f"{item.source_image}:{item.source_position or 'unknown'}"
            position_match = re.fullmatch(r"r(\d+)c(\d+)", item.source_position or "")
            row_index = int(position_match.group(1)) - 1 if position_match else 0
            column_index = int(position_match.group(2)) - 1 if position_match else 0
            rows.append(InventorySummaryRow(
                # A routine rebuild inside one workspace version keeps its
                # id.  A successful full OCR replacement has already cleared
                # ``rows``, so it necessarily receives a new id set.
                id=existing_ids_by_occurrence.get(occurrence_id, f"star_{uuid4().hex}"),
                kind=entry.kind,
                name=item.final_name,
                level=item.final_level,
                quality=item.final_quality,
                quantity=1,
                equipped_state=item.equipped_state,
                source_image=item.source_image,
                source_position=item.source_position,
                occurrence_id=occurrence_id,
                manual_status="人工核对" if item.manual_override else "OCR",
                upload_batch_index=0,
                source_image_index=source_indexes.get(item.source_image, 0),
                row_index=row_index,
                column_index=column_index,
            ))
        self.rows = normalize_instance_rows(rows, self.catalog.order_index)
        self._sync_plan_targets()

    @staticmethod
    def _position_indexes(position: str | None) -> tuple[int, int] | None:
        match = re.fullmatch(r"r(\d+)c(\d+)", position or "")
        if not match:
            return None
        return int(match.group(1)), int(match.group(2))

    def _complete_rows_for_image(self, image_id: str) -> list[list[DetectedStarItem]]:
        grouped: dict[int, dict[int, DetectedStarItem]] = {}
        for item in self.detected_items:
            if item.source_image != image_id or item.inventory_action != "keep":
                continue
            position = self._position_indexes(item.source_position)
            if position is None:
                continue
            row_index, column_index = position
            grouped.setdefault(row_index, {})[column_index] = item
        complete: list[list[DetectedStarItem]] = []
        for row_index in sorted(grouped):
            columns = grouped[row_index]
            if set(columns) != {1, 2, 3, 4}:
                continue
            row = [columns[column] for column in range(1, 5)]
            if all(item.is_complete_card and item.final_name and item.final_level for item in row):
                complete.append(row)
        return complete

    @staticmethod
    def _row_signature(row: list[DetectedStarItem]) -> tuple[tuple[str, int], ...]:
        return tuple((str(item.final_name), int(item.final_level or 0)) for item in row)

    def recalculate_postprocess(self) -> None:
        """Re-evaluate marked four-card suffix/prefix overlaps without rerunning OCR."""
        items = [
            item.model_copy(update={"overlap_duplicate_of": None})
            for item in self.detected_items
        ]
        self.detected_items = items
        by_card_id = {item.card_id: item for item in items if item.card_id}
        parent = {card_id: card_id for card_id in by_card_id}

        def find(card_id: str) -> str:
            while parent[card_id] != card_id:
                parent[card_id] = parent[parent[card_id]]
                card_id = parent[card_id]
            return card_id

        audit: list[dict[str, object]] = []
        manual_pair_conflict_ids: set[str] = set()
        for pool in ("main", "support"):
            for before_id, after_id in self.overlap_pairs.get(pool, []):
                if self.image_pools.get(before_id) != pool or self.image_pools.get(after_id) != pool:
                    audit.append({
                        "pool": pool,
                        "before_image": before_id,
                        "after_image": after_id,
                        "status": "冲突",
                        "reason": "手工关系与当前图片池不一致，已保留但未应用",
                        "merged_occurrences": 0,
                    })
                    continue
                before_rows = self._complete_rows_for_image(before_id)
                after_rows = self._complete_rows_for_image(after_id)
                matched_rows: list[tuple[list[DetectedStarItem], list[DetectedStarItem]]] = []
                for length in range(min(len(before_rows), len(after_rows)), 0, -1):
                    candidates = list(zip(before_rows[-length:], after_rows[:length]))
                    if all(
                        self._row_signature(before) == self._row_signature(after)
                        for before, after in candidates
                    ):
                        matched_rows = candidates
                        break
                merged = 0
                for before_row, after_row in matched_rows:
                    for before_item, after_item in zip(before_row, after_row):
                        if not before_item.card_id or not after_item.card_id:
                            continue
                        before_root = find(before_item.card_id)
                        after_root = find(after_item.card_id)
                        if before_root != after_root:
                            parent[after_root] = before_root
                            merged += 1
                manual_pair_conflict = False
                if not matched_rows and before_rows and after_rows:
                    for before_item, after_item in zip(before_rows[-1], after_rows[0]):
                        if not (before_item.manual_override and after_item.manual_override):
                            continue
                        before_value = (
                            before_item.final_name,
                            before_item.final_level,
                            before_item.final_quality,
                        )
                        after_value = (
                            after_item.final_name,
                            after_item.final_level,
                            after_item.final_quality,
                        )
                        if before_value != after_value:
                            manual_pair_conflict = True
                            if before_item.card_id:
                                manual_pair_conflict_ids.add(before_item.card_id)
                            if after_item.card_id:
                                manual_pair_conflict_ids.add(after_item.card_id)
                audit.append({
                    "pool": pool,
                    "before_image": before_id,
                    "after_image": after_id,
                    "status": "冲突" if manual_pair_conflict else "已应用" if merged else "未合并",
                    "reason": (
                        "重叠边界存在互相冲突的人工值，已暂停合并"
                        if manual_pair_conflict
                        else None if merged
                        else "未找到名称和等级完全一致的连续四卡行"
                    ),
                    "merged_occurrences": merged,
                    "source": "user_marked",
                })

        groups: dict[str, list[str]] = {}
        for card_id in parent:
            groups.setdefault(find(card_id), []).append(card_id)
        duplicate_of: dict[str, str] = {}
        conflict_ids: set[str] = set(manual_pair_conflict_ids)
        for members in groups.values():
            if len(members) < 2:
                continue
            manual_values = {
                (
                    by_card_id[card_id].final_name,
                    by_card_id[card_id].final_level,
                    by_card_id[card_id].final_quality,
                )
                for card_id in members
                if by_card_id[card_id].manual_override
            }
            if len(manual_values) > 1:
                conflict_ids.update(members)
                audit.append({
                    "pool": "manual",
                    "status": "冲突",
                    "reason": "同一重叠组存在互相冲突的人工值，已暂停合并",
                    "merged_occurrences": 0,
                    "source": "manual_override",
                })
                continue
            primary = max(
                members,
                key=lambda card_id: (
                    bool(by_card_id[card_id].manual_override),
                    float(by_card_id[card_id].confidence or 0.0),
                    card_id,
                ),
            )
            for card_id in members:
                if card_id != primary:
                    duplicate_of[card_id] = primary
        updated_items: list[DetectedStarItem] = []
        for item in self.detected_items:
            warnings = [
                warning
                for warning in item.field_warnings
                if warning != "manual_overlap_value_conflict"
            ]
            if item.card_id in conflict_ids:
                warnings.append("manual_overlap_value_conflict")
            updated_items.append(item.model_copy(update={
                "overlap_duplicate_of": duplicate_of.get(item.card_id or ""),
                "field_warnings": warnings,
            }))
        self.detected_items = updated_items
        self.overlap_audit = audit
        self._rebuild_rows_from_detected()
        self.postprocess_revision += 1

    def set_card_inventory_action(self, card_id: str, action: str) -> None:
        if action not in {"keep", "exclude_fragment", "exclude_false_box"}:
            raise ValueError("卡片处理动作无效")
        index = next((index for index, item in enumerate(self.detected_items) if item.card_id == card_id), None)
        if index is None:
            raise ValueError("未找到 OCR 卡片")
        self._record()
        self.detected_items[index] = self.detected_items[index].model_copy(update={"inventory_action": action})
        self.recalculate_postprocess()

    def update_detected_card(
        self, card_id: str, *, name: str | None, level: int | str | None, quality: Quality | str | None,
    ) -> None:
        index = next((index for index, item in enumerate(self.detected_items) if item.card_id == card_id), None)
        if index is None:
            raise ValueError("未找到 OCR 卡片")
        parsed_level = parse_integer(level, label="等级", minimum=1, maximum=60, allow_blank=True, blank_value=None)
        parsed_name = self.catalog.normalize(name) if name else None
        if parsed_name:
            self.catalog.entry(parsed_name)
        parsed_quality = Quality(quality) if quality else None
        self._record()
        self.detected_items[index] = self.detected_items[index].model_copy(update={
            "final_name": parsed_name, "final_level": parsed_level, "final_quality": parsed_quality,
            "manual_override": True, "inventory_action": "keep",
        })
        self.recalculate_postprocess()

    def set_image_pool(self, image_id: str, pool: str) -> None:
        if pool not in {"main", "support", "experience", "unknown"}:
            raise ValueError("图片池无效")
        if not any(image.id == image_id for image in self.uploaded_images):
            raise ValueError("未找到图片")
        previous_pool = self.image_pools.get(image_id)
        self.image_pools[image_id] = pool
        self.confirmed_image_pools.add(image_id)
        if previous_pool != pool:
            self.overlap_pairs["main"] = [pair for pair in self.overlap_pairs["main"] if image_id not in pair]
            self.overlap_pairs["support"] = [pair for pair in self.overlap_pairs["support"] if image_id not in pair]
            if self.detected_items:
                self.recalculate_postprocess()

    def unclassified_images(self) -> list[ImageInput]:
        """Return the ordered, state-owned queue of images needing manual routing."""
        return [
            image
            for image in self.uploaded_images
            if self.image_pools.get(image.id, "unknown") == "unknown"
        ]

    def route_unclassified_image(self, image_id: str, pool: str) -> ImageInput:
        """Atomically route one unknown image and mark its classification confirmed."""
        if pool not in {"main", "support", "experience"}:
            raise ValueError("请选择主星池、辅星池或经验星曜池")
        image = next(
            (candidate for candidate in self.uploaded_images if candidate.id == image_id),
            None,
        )
        if image is None:
            raise ValueError("未找到待分流图片，页面可能已过期")
        if self.image_pools.get(image_id, "unknown") != "unknown":
            raise ValueError("该图片已由其他操作完成分流")
        if image.missing or not image.content:
            raise ValueError("图片副本暂时不可读取，请恢复图片后重试")

        before = self.snapshot()
        selected_row_id = self.selected_row_id
        selected_import_image_id = self.selected_import_image_id
        try:
            self.detected_items = [
                item.model_copy(update={"page_type": pool})
                if item.source_image == image_id
                else item
                for item in self.detected_items
            ]
            audit = self.image_audit.get(image_id)
            if isinstance(audit, dict):
                audit["page_type"] = pool
            self.set_image_pool(image_id, pool)
        except Exception:
            self.restore(before)
            self.selected_row_id = selected_row_id
            self.selected_import_image_id = selected_import_image_id
            raise
        return image

    def confirm_all_image_pools(self) -> tuple[int, list[str]]:
        """Confirm current suggestions without altering unrelated overlap pairs."""
        failures: list[str] = []
        confirmed = 0
        for image in self.uploaded_images:
            pool = self.image_pools.get(image.id, "unknown")
            if pool == "unknown":
                failures.append(f"{image.filename}: 分类仍为待确认")
                continue
            before = image.id in self.confirmed_image_pools
            self.set_image_pool(image.id, pool)
            if not before:
                confirmed += 1
        return confirmed, failures

    def confirm_image_pool(self, pool: str) -> tuple[int, list[str]]:
        """Confirm the current UI values for one pool without touching other pools."""
        if pool not in {"main", "support", "experience"}:
            raise ValueError("图片池无效")
        failures: list[str] = []
        confirmed = 0
        for image in self.uploaded_images:
            if self.image_pools.get(image.id) != pool:
                continue
            before = image.id in self.confirmed_image_pools
            self.set_image_pool(image.id, pool)
            if not before:
                confirmed += 1
        return confirmed, failures

    def suggest_image_pool(self, image_id: str, pool: str) -> None:
        if pool not in {"main", "support", "experience", "unknown"}:
            raise ValueError("图片池无效")
        if not any(image.id == image_id for image in self.uploaded_images):
            raise ValueError("未找到图片")
        if image_id not in self.confirmed_image_pools:
            self.image_pools[image_id] = pool

    def add_overlap_pair(self, pool: str, before_id: str, after_id: str) -> None:
        if pool not in self.overlap_pairs or before_id == after_id:
            raise ValueError("重叠关系无效")
        if before_id not in self.confirmed_image_pools or after_id not in self.confirmed_image_pools:
            raise ValueError("请先确认两张图片的分类")
        if self.image_pools.get(before_id) != pool or self.image_pools.get(after_id) != pool:
            raise ValueError("只能在同一已确认图片池内标记关系")
        pair = (before_id, after_id)
        if pair in self.overlap_pairs[pool]:
            raise ValueError("该重叠关系已存在")
        self.overlap_pairs[pool].append(pair)
        if self.detected_items:
            self.recalculate_postprocess()

    def remove_overlap_pair(self, pool: str, before_id: str, after_id: str) -> None:
        self.overlap_pairs[pool] = [pair for pair in self.overlap_pairs.get(pool, []) if pair != (before_id, after_id)]
        if self.detected_items:
            self.recalculate_postprocess()

    def add_uploaded_image(self, image: ImageInput) -> None:
        if any(existing.id == image.id for existing in self.uploaded_images):
            raise ValueError("待识别图片标识重复")
        self.uploaded_images.append(image)

    def remove_uploaded_image(self, image_id: str) -> bool:
        original_count = len(self.uploaded_images)
        self.uploaded_images = [image for image in self.uploaded_images if image.id != image_id]
        self.image_pools.pop(image_id, None)
        self.confirmed_image_pools.discard(image_id)
        self.image_audit.pop(image_id, None)
        if self.selected_import_image_id == image_id:
            self.selected_import_image_id = None
        had_detected_items = bool(self.detected_items)
        self.detected_items = [item for item in self.detected_items if item.source_image != image_id]
        self.overlap_pairs["main"] = [pair for pair in self.overlap_pairs["main"] if image_id not in pair]
        self.overlap_pairs["support"] = [pair for pair in self.overlap_pairs["support"] if image_id not in pair]
        if had_detected_items:
            self.recalculate_postprocess()
        return len(self.uploaded_images) != original_count

    def save_bag_info(
        self,
        game_version: GameVersion | str,
        bag_current_count: int | str | None,
        bag_capacity: int | str | None,
        account_name: str | None = None,
    ) -> None:
        parsed_count = parse_integer(
            bag_current_count, label="背包当前数量", minimum=0, allow_blank=True, blank_value=None
        )
        parsed_capacity = parse_integer(
            bag_capacity, label="背包容量", minimum=1, allow_blank=True, blank_value=None
        )
        parsed_game_version = GameVersion(game_version)
        self._record()
        self.game_version = parsed_game_version
        if account_name is not None:
            self.account_name = str(account_name).strip()[:80]
        self.bag_current_count = parsed_count
        self.bag_capacity = parsed_capacity
        self.bag_manual_fields = {"bag_current_count", "bag_capacity"}
        self.bag_resolution = {
            "status": "manual",
            "bag_current_count": parsed_count,
            "bag_capacity": parsed_capacity,
            "warning": None,
            "candidates": [],
        }
        if self.import_batch is None:
            self.import_batch = ImportBatch(
                image_count=0,
                game_version=parsed_game_version,
                bag_current_count=parsed_count,
                bag_capacity=parsed_capacity,
            )
        else:
            self.import_batch = self.import_batch.model_copy(
                update={
                    "game_version": parsed_game_version,
                    "bag_current_count": parsed_count,
                    "bag_capacity": parsed_capacity,
                }
            )

    def save_game_version(self, game_version: GameVersion | str) -> bool:
        """Persist the current workspace game without changing OCR behavior."""
        parsed = GameVersion(game_version)
        if parsed == self.game_version:
            return False
        self._record()
        self.game_version = parsed
        return True

    def save_account_name(self, account_name: str | None) -> None:
        value = str(account_name or "").strip()[:80]
        if value == self.account_name:
            return
        self._record()
        self.account_name = value

    def save_experience(
        self,
        purple: int | str | None,
        white: int | str | None,
        orange: int | str | None = None,
    ) -> None:
        parsed_orange = parse_integer(
            orange, label="橙星曜数量", minimum=0, allow_blank=True, blank_value=None
        )
        parsed_purple = parse_integer(
            purple, label="紫星曜数量", minimum=0, allow_blank=True, blank_value=None
        )
        parsed_white = parse_integer(
            white, label="白星曜数量", minimum=0, allow_blank=True, blank_value=None
        )
        self._record()
        self.experience_quantities = {
            "橙星曜": parsed_orange,
            "紫星曜": parsed_purple,
            "白星曜": parsed_white,
        }
        self.experience_manual_fields = {"橙星曜", "紫星曜", "白星曜"}
        self.experience_evidence = {
            name: {
                **deepcopy(self.experience_evidence.get(name, {})),
                "value": value,
                "confidence": None,
                "warning": None,
                "status": "manual",
            }
            for name, value in self.experience_quantities.items()
        }

    def experience_quantity_needs_review(self, name: str) -> bool:
        """Return whether OCR saw this icon but could not safely parse its count."""
        evidence = self.experience_evidence.get(name, {})
        return (
            self.experience_quantities.get(name) is None
            and isinstance(evidence, dict)
            and evidence.get("icon_detected") is True
        )

    def undo(self) -> bool:
        current = self.snapshot()
        current["history_uploaded_images"] = deepcopy(self.uploaded_images)
        previous = self.history.undo(current)
        if previous is None:
            return False
        self.restore(previous)
        self.recalculate_postprocess()
        return True

    def redo(self) -> bool:
        current = self.snapshot()
        current["history_uploaded_images"] = deepcopy(self.uploaded_images)
        following = self.history.redo(current)
        if following is None:
            return False
        self.restore(following)
        self.recalculate_postprocess()
        return True

    def selected_row(self) -> InventorySummaryRow | None:
        return next((row for row in self.rows if row.id == self.selected_row_id), None)

    def experience_resources(self):
        from .domain import ExperienceResource

        return [
            ExperienceResource(name=name, quantity=self.experience_quantities[name], experience_per_item=experience)
            for name, experience in (("橙星曜", None), ("紫星曜", 500), ("白星曜", 100))
            if self.experience_quantities[name] is not None
        ]

    def set_filters(self, kind: str, quality: str, name: str) -> None:
        self.filter_kind = kind
        self.filter_quality = quality
        self.filter_name = name

    def filtered_rows(self) -> WebInventoryRows:
        rows = self.rows
        has_active_filter = (
            self.filter_kind != "全部"
            or self.filter_quality != "全部"
            or bool(self.filter_name.strip())
        )
        if self.filter_kind != "全部":
            rows = [row for row in rows if row.kind.value == self.filter_kind]
        if self.filter_quality != "全部":
            rows = [row for row in rows if row.quality.value == self.filter_quality]
        terms = [term for term in re.split(r"[\s,，、;；]+", self.filter_name.strip()) if term]
        if terms:
            normalized_terms = list(dict.fromkeys(self.catalog.normalize(term) for term in terms))
            rows = [
                row
                for row in rows
                if any(
                    term in row.name or term in row.display_name or self.catalog.normalize(term) == row.name
                    for term in normalized_terms
                )
            ]
        instances = normalize_instance_rows(rows, self.catalog.order_index)
        return WebInventoryRows(
            sorted(
                instances,
                key=lambda row: web_inventory_sort_key(
                    row,
                    self.catalog.order_index,
                    filtered=has_active_filter,
                ),
            ),
            filtered=has_active_filter,
        )

    def group_counts_for_filtered_rows(self) -> dict[str, int | None]:
        """Return a count only for the first visible instance in each continuous group."""
        result: dict[str, int | None] = {}
        previous_key: tuple[object, ...] | None = None
        rows = self.filtered_rows()
        totals: dict[tuple[object, ...], int] = {}
        for row in rows:
            key = web_inventory_group_key(row, filtered=rows.filtered)
            totals[key] = totals.get(key, 0) + 1
        for row in rows:
            key = web_inventory_group_key(row, filtered=rows.filtered)
            result[row.id] = totals[key] if key != previous_key else None
            previous_key = key
        return result
