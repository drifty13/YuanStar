from __future__ import annotations

import base64
from statistics import median

import cv2
import numpy as np

from .contracts import AnalysisResult, ImageInput, ImportProgressCallback, ImportProgressEvent
from ..domain import DetectedStarItem, ImportBatch, Quality
from .offline_pipeline import OfflineSingleImagePipeline
from .ocr_engine import LocalRapidOcr
from .page_classifier import classify_page
from .targeted_overlap import DirectedPair, align_directed_pair
from .viewport import detect_viewport


class NotImplementedVisionPipeline:
    """Explicit placeholder: it never creates or implies OCR output."""

    def analyze(self, images: list[ImageInput], batch: ImportBatch) -> AnalysisResult:
        return AnalysisResult(
            executed=False,
            message="图片已进入待识别批次；当前版本尚未执行 OCR，请进入人工核对页录入数据。",
            items=[],
            import_batch=batch,
        )


class LocalOfflineVisionPipeline:
    """Local web batch bridge around the authoritative per-image pipeline."""

    def __init__(self) -> None:
        self._pipeline = OfflineSingleImagePipeline()

    @property
    def canonical_pipeline(self) -> OfflineSingleImagePipeline:
        """The single authoritative per-image OCR/normalization entry."""
        return self._pipeline

    def analyze_decoded_image(
        self,
        image: np.ndarray,
        image_id: str,
    ) -> tuple[object, object]:
        """Route the web batch bridge through the canonical per-image entry."""
        return self._pipeline.analyze_image(image, image_id)

    def classify_pool(self, image: ImageInput) -> str:
        """Local preflight page classification without card OCR or detection."""
        decoded = cv2.imdecode(np.frombuffer(image.content, dtype=np.uint8), cv2.IMREAD_COLOR)
        if decoded is None:
            raise ValueError(f"{image.filename}: 无法解码")
        viewport = detect_viewport(decoded)
        return classify_page(decoded, viewport.viewport_box, self._pipeline.engine).page_type

    @staticmethod
    def _preview_data_url(image: np.ndarray, boxes: list[tuple[int, int, int, int]]) -> str | None:
        preview = image.copy()
        for x, y, width, height in boxes:
            cv2.rectangle(preview, (x, y), (x + width, y + height), (36, 180, 90), 3)
        ok, encoded = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 72])
        if not ok:
            return None
        return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")

    @staticmethod
    def _row_crop_boxes(
        cards: list[object],
        image_width: int,
        image_height: int,
    ) -> dict[int, tuple[int, int, int, int]]:
        """Use the row's real level/name OCR limits with radius-relative padding."""
        by_row: dict[int, list[object]] = {}
        for card in cards:
            if (
                getattr(card, "name_box_original", None) is None
                or getattr(card, "level_box_original", None) is None
            ):
                continue
            row_index = int(getattr(card, "row_index"))
            by_row.setdefault(row_index, []).append(card)
        result: dict[int, tuple[int, int, int, int]] = {}
        for row_index, row in by_row.items():
            ordered = sorted(row, key=lambda card: int(getattr(card, "column_index")))
            radii = []
            for card in ordered:
                circle = getattr(card, "circle_original", None)
                if circle is not None:
                    radii.append(float(circle[2]))
                    continue
                _, _, width, height = getattr(card, "box_original")
                radii.append((width / 2.10 + height / 2.05) / 2)
            row_radius = median(radii)
            padding = round(row_radius * 0.05)
            first_box = getattr(ordered[0], "box_original")
            last_box = getattr(ordered[-1], "box_original")
            level_boxes = [getattr(card, "level_box_original") for card in ordered]
            name_boxes = [getattr(card, "name_box_original") for card in ordered]
            left = max(0, int(first_box[0] - padding))
            right = min(
                image_width,
                int(last_box[0] + last_box[2] + padding),
            )
            top = max(0, min(box[1] for box in level_boxes) - padding)
            bottom = min(
                image_height,
                max(box[1] + box[3] for box in name_boxes) + padding,
            )
            if right > left and bottom > top:
                result[row_index] = (left, top, right - left, bottom - top)
        return result

    @staticmethod
    def _auto_excluded_edge_fragments(
        cards: list[object],
        image_height: int,
        *,
        content_top: int | None = None,
        content_bottom: int | None = None,
    ) -> dict[str, str]:
        """Classify disc or OCR-field cuts before fields can enter inventory."""
        excluded: dict[str, str] = {}
        circles: dict[str, tuple[int, int, int]] = {}
        circle_edges: dict[str, str] = {}
        for card in cards:
            circle = getattr(card, "circle_original", None)
            if circle is None:
                x, y, width, height = getattr(card, "box_original")
                radius = max(1, round((width / 2.10 + height / 2.05) / 2))
                circle = (round(x + 1.05 * radius), y + radius, radius)
            _, center_y, radius = circle
            card_id = str(getattr(card, "card_id"))
            circles[card_id] = circle
            if center_y - radius < (
                content_top if content_top is not None else 0
            ):
                excluded[card_id] = "top"
                circle_edges[card_id] = "top"
            elif center_y + radius > (
                content_bottom if content_bottom is not None else image_height
            ):
                excluded[card_id] = "bottom"
                circle_edges[card_id] = "bottom"
            else:
                for box in (
                    getattr(card, "name_box_original", None),
                    getattr(card, "level_box_original", None),
                ):
                    if box is None:
                        continue
                    _, box_y, _, box_height = box
                    if box_y < (content_top if content_top is not None else 0):
                        excluded[card_id] = "top"
                        break
                    if box_y + box_height > (
                        content_bottom if content_bottom is not None else image_height
                    ):
                        excluded[card_id] = "bottom"
                        break

        # Narrow consistency guard: only a genuine four-column row can inherit
        # a circle edge decision, and only when its four disc boundaries agree
        # within normal detector-radius jitter.  Text-box cuts stay per-card.
        by_row: dict[int, list[object]] = {}
        for card in cards:
            by_row.setdefault(int(getattr(card, "row_index")), []).append(card)
        for row in by_row.values():
            if len(row) != 4 or {
                int(getattr(card, "column_index")) for card in row
            } != {0, 1, 2, 3}:
                continue
            radii = [circles[str(getattr(card, "card_id"))][2] for card in row]
            tolerance = max(2.0, median(radii) * 0.25)
            for edge in ("top", "bottom"):
                if not any(
                    circle_edges.get(str(getattr(card, "card_id"))) == edge
                    for card in row
                ):
                    continue
                boundaries = [
                    circle[1] - circle[2] if edge == "top" else circle[1] + circle[2]
                    for card in row
                    for circle in [circles[str(getattr(card, "card_id"))]]
                ]
                if max(boundaries) - min(boundaries) <= tolerance:
                    for card in row:
                        excluded[str(getattr(card, "card_id"))] = edge
        return excluded

    @staticmethod
    def _overlap_resolution(
        analyses: dict[str, object], images: dict[str, np.ndarray], pairs: dict[str, list[tuple[str, str]]], item_by_ref: dict[str, str],
    ) -> tuple[list[list[str]], list[dict[str, object]]]:
        """Use only user-marked directed pairs and retain visual evidence gates."""
        parent = {item_id: item_id for item_id in item_by_ref.values()}
        audit: list[dict[str, object]] = []

        def find(value: str) -> str:
            while parent[value] != value:
                parent[value] = parent[parent[value]]
                value = parent[value]
            return value

        for pool in ("main", "support"):
            for index, (before_id, after_id) in enumerate(pairs.get(pool, []), 1):
                before = analyses.get(before_id)
                after = analyses.get(after_id)
                before_image = images.get(before_id)
                after_image = images.get(after_id)
                if before is None or after is None or before_image is None or after_image is None:
                    audit.append({
                        "pool": pool,
                        "before_image": before_id,
                        "after_image": after_id,
                        "status": "未应用",
                        "reason": "前图或后图没有可用分析结果",
                        "merged_occurrences": 0,
                    })
                    continue
                result = align_directed_pair(
                    DirectedPair(f"local_{pool}_{index}", before_id, after_id, "user_marked", pool),
                    before, before_image, after, after_image,
                )
                merged_occurrences = 0
                for row in result.rows:
                    if row.conclusion != "confirmed_overlap":
                        continue
                    for left, right in row.occurrence_mapping:
                        left_item = item_by_ref.get(left)
                        right_item = item_by_ref.get(right)
                        if left_item is None or right_item is None:
                            continue
                        left_root, right_root = find(left_item), find(right_item)
                        if left_root != right_root:
                            parent[right_root] = left_root
                            merged_occurrences += 1
                audit.append({
                    "pool": pool,
                    "before_image": before_id,
                    "after_image": after_id,
                    "status": "已应用" if merged_occurrences else "未合并",
                    "reason": None if merged_occurrences else "未找到同时通过视觉证据门禁的重叠行",
                    "merged_occurrences": merged_occurrences,
                })
        groups: dict[str, list[str]] = {}
        for item_id in parent:
            groups.setdefault(find(item_id), []).append(item_id)
        return [members for members in groups.values() if len(members) > 1], audit

    @staticmethod
    def _overlap_groups(
        analyses: dict[str, object],
        images: dict[str, np.ndarray],
        pairs: dict[str, list[tuple[str, str]]],
        item_by_ref: dict[str, str],
    ) -> list[list[str]]:
        """Compatibility wrapper retained for the existing unmarked-pair regression."""
        return LocalOfflineVisionPipeline._overlap_resolution(analyses, images, pairs, item_by_ref)[0]

    @staticmethod
    def _resolve_bag_observations(observations: list[dict[str, object]]) -> dict[str, object]:
        reliable = [
            item for item in observations
            if isinstance(item.get("bag_current_count"), int)
            and isinstance(item.get("bag_capacity"), int)
            and float(item.get("confidence") or 0.0) >= .65
        ]
        values = {
            (int(item["bag_current_count"]), int(item["bag_capacity"]))
            for item in reliable
        }
        if not reliable:
            return {
                "status": "未识别",
                "bag_current_count": None,
                "bag_capacity": None,
                "source_images": [],
                "confidence": None,
                "warning": "没有可靠的背包数量/容量候选",
                "candidates": observations,
            }
        if len(values) > 1:
            return {
                "status": "候选冲突",
                "bag_current_count": None,
                "bag_capacity": None,
                "source_images": [str(item.get("source_filename") or item["source_image"]) for item in reliable],
                "confidence": min(float(item["confidence"]) for item in reliable),
                "warning": "多张截图的背包数量/容量不一致，请人工确认",
                "candidates": reliable,
            }
        current, capacity = next(iter(values))
        return {
            "status": "一致",
            "bag_current_count": current,
            "bag_capacity": capacity,
            "source_images": [str(item.get("source_filename") or item["source_image"]) for item in reliable],
            "confidence": min(float(item["confidence"]) for item in reliable),
            "warning": None,
            "candidates": reliable,
        }

    @staticmethod
    def _resolve_experience_observations(
        observations: list[dict[str, object]],
    ) -> dict[str, dict[str, object]]:
        result: dict[str, dict[str, object]] = {}
        for label, value_key, confidence_key in (
            ("橙星曜", "orange_count", "orange_confidence"),
            ("紫星曜", "purple_count", "purple_confidence"),
            ("白星曜", "white_count", "white_confidence"),
        ):
            evidence_key = {
                "橙星曜": "orange",
                "紫星曜": "purple",
                "白星曜": "white",
            }[label]
            icon_candidates: list[tuple[dict[str, object], dict[str, object]]] = []
            for item in observations:
                evidence = item.get("evidence")
                field_evidence = evidence.get(evidence_key) if isinstance(evidence, dict) else None
                if isinstance(field_evidence, dict) and field_evidence.get("icon_detected") is True:
                    icon_candidates.append((item, field_evidence))
            raw_texts = [
                str(raw)
                for _, field_evidence in icon_candidates
                for raw in field_evidence.get("raw_texts", [])
                if isinstance(raw, str)
            ]
            source_images = [
                str(item.get("source_filename") or item["source_image"])
                for item, _ in icon_candidates
            ]
            evidence_fields = {
                "icon_detected": bool(icon_candidates),
                "raw_texts": raw_texts,
                "count_boxes": [field.get("count_box") for _, field in icon_candidates],
                "icon_boxes": [field.get("icon_box") for _, field in icon_candidates],
            }
            reliable = [
                item for item in observations
                if isinstance(item.get(value_key), int)
                and float(item.get(confidence_key) or 0.0) >= .65
            ]
            values = {int(item[value_key]) for item in reliable}
            if not reliable:
                result[label] = {
                    "value": None,
                    "confidence": None,
                    "source_images": source_images,
                    "warning": "没有可靠候选",
                    "status": "未识别",
                    "candidates": observations,
                    **evidence_fields,
                }
            elif len(values) > 1:
                result[label] = {
                    "value": None,
                    "confidence": min(float(item[confidence_key]) for item in reliable),
                    "source_images": [str(item.get("source_filename") or item["source_image"]) for item in reliable],
                    "warning": "多张经验星石截图的数量不一致，请人工确认",
                    "status": "候选冲突",
                    "candidates": reliable,
                    **evidence_fields,
                }
            else:
                result[label] = {
                    "value": next(iter(values)),
                    "confidence": min(float(item[confidence_key]) for item in reliable),
                    "source_images": [str(item.get("source_filename") or item["source_image"]) for item in reliable],
                    "warning": None,
                    "status": "已识别",
                    "candidates": reliable,
                    **evidence_fields,
                }
        return result

    def analyze(
        self,
        images: list[ImageInput],
        batch: ImportBatch,
        overlap_pairs: dict[str, list[tuple[str, str]]] | None = None,
        progress: ImportProgressCallback | None = None,
    ) -> AnalysisResult:
        items: list[DetectedStarItem] = []
        pools: dict[str, str] = {}
        image_audit: dict[str, dict[str, object]] = {}
        warnings: list[str] = []
        analyses: dict[str, object] = {}
        decoded_images: dict[str, np.ndarray] = {}
        item_by_ref: dict[str, str] = {}
        bag_observations: list[dict[str, object]] = []
        experience_observations: list[dict[str, object]] = []
        def emit(stage: str, *, completed: int = 0, image_index: int | None = None, image: ImageInput | None = None, detail: str | None = None) -> None:
            if progress:
                progress(ImportProgressEvent(
                    stage=stage, total_images=len(images), completed_images=completed,
                    current_image_index=image_index, current_filename=image.filename if image else None,
                    error_count=len(warnings), engine_initializations=LocalRapidOcr.initialization_count(), detail=detail,
                ))

        emit("准备任务")
        emit("初始化或复用 OCR 引擎", detail="首次加载 OCR 引擎" if not LocalRapidOcr.is_initialized() else "复用 OCR 引擎")
        for image_index, image in enumerate(images, 1):
            emit("读取图片", completed=image_index - 1, image_index=image_index, image=image)
            decoded = cv2.imdecode(np.frombuffer(image.content, dtype=np.uint8), cv2.IMREAD_COLOR)
            if decoded is None:
                warnings.append(f"{image.filename}: 无法解码")
                emit("读取图片", completed=image_index, image_index=image_index, image=image, detail="无法解码")
                continue
            emit("卡片检测", completed=image_index - 1, image_index=image_index, image=image)
            analysis, _ = self.analyze_decoded_image(decoded, image.id)
            if analysis.page.page_type == "experience":
                emit("经验星石识别", completed=image_index - 1, image_index=image_index, image=image)
            else:
                emit("名称识别", completed=image_index - 1, image_index=image_index, image=image)
                emit("等级识别", completed=image_index - 1, image_index=image_index, image=image)
                emit("品质识别", completed=image_index - 1, image_index=image_index, image=image)
            emit("背包数量与容量识别", completed=image_index - 1, image_index=image_index, image=image)
            analyses[image.id] = analysis
            decoded_images[image.id] = decoded
            pools[image.id] = analysis.page.page_type
            stars = {star.card_id: star for star in analysis.stars}
            auto_excluded_fragments = self._auto_excluded_edge_fragments(
                analysis.cards,
                decoded.shape[0],
                content_top=analysis.content_bounds[0] if analysis.content_bounds else None,
                content_bottom=analysis.content_bounds[1] if analysis.content_bounds else None,
            )
            review_cards = [
                card
                for card in analysis.cards
                if card.card_id not in auto_excluded_fragments
            ]
            row_crop_boxes = self._row_crop_boxes(
                review_cards,
                decoded.shape[1],
                decoded.shape[0],
            )
            analyses[image.id] = type(analysis)(
                analysis.image_id,
                analysis.viewport,
                analysis.page,
                review_cards,
                [
                    star
                    for star in analysis.stars
                    if star.card_id not in auto_excluded_fragments
                ],
                analysis.warnings,
                analysis.experience,
                analysis.bag,
                analysis.equipped_classifier_calls,
                analysis.content_bounds,
            )
            for card in analysis.cards:
                star = next((value for value in analysis.stars if value.card_id == card.card_id), None)
                quality = Quality(star.quality) if star and star.quality in {item.value for item in Quality} else None
                position = f"r{card.row_index + 1}c{card.column_index + 1}"
                card_id = f"{image.id}:{card.card_id}"
                fragment_edge = auto_excluded_fragments.get(card.card_id)
                item = DetectedStarItem(
                    card_id=card_id, source_image=image.id, source_position=position, page_type=analysis.page.page_type,
                    row_crop_box=(
                        None
                        if fragment_edge is not None
                        else row_crop_boxes.get(card.row_index)
                    ),
                    recognized_name=star.canonical_name if star else None, recognized_level=star.level if star else None,
                    recognized_quality=quality, final_name=star.canonical_name if star else None,
                    final_level=star.level if star else None, final_quality=quality,
                    equipped_state=star.equipped_state if star else "not_evaluated",
                    confidence=star.overall_confidence if star else None,
                    is_complete_card=card.is_complete and fragment_edge is None,
                    field_warnings=(star.warnings + star.quality_warnings if star else ["no_recognized_star_for_candidate"])
                    + ([] if card.is_complete else ["incomplete_card"])
                    + (
                        [f"auto_excluded_edge_fragment_{fragment_edge}"]
                        if fragment_edge is not None
                        else []
                    ),
                    inventory_action=(
                        "auto_excluded_edge_fragment"
                        if fragment_edge is not None
                        else "keep"
                    ),
                )
                items.append(item)
                item_by_ref[f"{image.id}:{position}"] = card_id
            if analysis.bag:
                bag_observations.append({
                    "source_image": image.id,
                    "source_filename": image.filename,
                    "bag_current_count": analysis.bag.current,
                    "bag_capacity": analysis.bag.capacity,
                    "confidence": analysis.bag.confidence,
                    "warning": "；".join(analysis.bag.warnings) if analysis.bag.warnings else None,
                    "raw_candidates": list(analysis.bag.candidates),
                })
            if analysis.experience:
                experience_observations.append({
                    "source_image": image.id,
                    "source_filename": image.filename,
                    "orange_count": analysis.experience.orange_count,
                    "purple_count": analysis.experience.purple_count,
                    "white_count": analysis.experience.white_count,
                    "orange_confidence": analysis.experience.orange_confidence,
                    "purple_confidence": analysis.experience.purple_confidence,
                    "white_confidence": analysis.experience.white_confidence,
                    "warning": "；".join(analysis.experience.warnings) if analysis.experience.warnings else None,
                    "complete": analysis.experience.complete,
                    "evidence": analysis.experience.evidence,
                })
            fully_resolved = sum(
                card.card_id not in auto_excluded_fragments
                and card.is_complete
                and (star := stars.get(card.card_id)) is not None
                and star.canonical_name is not None
                and star.level is not None
                and star.quality is not None
                for card in analysis.cards
            )
            image_audit[image.id] = {
                "page_type": analysis.page.page_type,
                "page_confidence": analysis.page.confidence,
                "warnings": analysis.warnings,
                "bag_current_count": analysis.bag.current if analysis.bag else None,
                "bag_capacity": analysis.bag.capacity if analysis.bag else None,
                "bag_confidence": analysis.bag.confidence if analysis.bag else None,
                "bag_warning": "；".join(analysis.bag.warnings) if analysis.bag and analysis.bag.warnings else None,
                "experience": experience_observations[-1] if analysis.experience else None,
                "equipped_classifier_calls": analysis.equipped_classifier_calls,
                "preview_data_url": self._preview_data_url(decoded, [card.box_original for card in analysis.cards]),
                "detected_occurrence_count": len(analysis.cards),
                "fully_resolved_count": fully_resolved,
                "accepted_cards": fully_resolved,
                "pending_cards": len(review_cards) - fully_resolved,
                "edge_fragment_excluded_count": len(auto_excluded_fragments),
                "bottom_ui_excluded_count": next(
                    (
                        int(warning.rsplit(":", 1)[1])
                        for warning in analysis.warnings
                        if warning.startswith("auto_excluded_bottom_ui:")
                    ),
                    0,
                ),
            }
            emit("完成图片", completed=image_index, image_index=image_index, image=image)
        emit("主星重叠", completed=len(images))
        groups, overlap_audit = self._overlap_resolution(analyses, decoded_images, overlap_pairs or {}, item_by_ref)
        emit("辅星重叠", completed=len(images))
        by_id = {item.card_id: item for item in items if item.card_id}
        for group in groups:
            primary = max(group, key=lambda card_id: by_id[card_id].confidence or 0.0)
            for card_id in group:
                if card_id != primary:
                    item = by_id[card_id]
                    replacement = item.model_copy(update={"overlap_duplicate_of": primary})
                    items[items.index(item)] = replacement
                    by_id[card_id] = replacement
        message = f"已在本机完成 {len(images)} 张图片的离线分析；完整且字段可用的卡片会进入人工核对。"
        if warnings:
            message += "\n" + "；".join(warnings)
        bag_resolution = self._resolve_bag_observations(bag_observations)
        experience_resolution = self._resolve_experience_observations(experience_observations)
        resolved_current = (
            batch.bag_current_count
            if batch.bag_current_count is not None
            else bag_resolution.get("bag_current_count")
        )
        resolved_capacity = (
            batch.bag_capacity
            if batch.bag_capacity is not None
            else bag_resolution.get("bag_capacity")
        )
        resolved_batch = batch.model_copy(update={
            "ocr_executed": True,
            "note": "本机离线 OCR 试运行",
            "bag_current_count": resolved_current,
            "bag_capacity": resolved_capacity,
        })
        emit("唯一清单", completed=len(images))
        emit("完整性校验", completed=len(images))
        emit("完成", completed=len(images))
        return AnalysisResult(
            executed=True, message=message, items=items,
            import_batch=resolved_batch,
            image_pools=pools,
            image_audit=image_audit,
            overlap_groups=groups,
            overlap_audit=overlap_audit,
            bag_resolution=bag_resolution,
            experience_resolution=experience_resolution,
            engine_initializations=LocalRapidOcr.initialization_count(),
        )
