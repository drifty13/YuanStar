from __future__ import annotations

from yuanstar.catalog import load_catalog
from yuanstar.domain import DetectedStarItem, GameVersion, ImportBatch, Quality
from yuanstar.session import SessionState
from yuanstar.vision.contracts import AnalysisResult, ImageInput
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline


def test_local_analysis_only_adds_complete_usable_cards_and_keeps_pending_out() -> None:
    state = SessionState(load_catalog())
    batch = ImportBatch(image_count=3, game_version=GameVersion.RU_YUAN, ocr_executed=True)
    result = AnalysisResult(executed=True, message="local", import_batch=batch, items=[
        DetectedStarItem(source_image="main", source_position="r1c1", final_name="天府", final_level=60, final_quality=Quality.ORANGE, is_complete_card=True),
        DetectedStarItem(source_image="support", source_position="r1c2", final_name=None, final_level=1, final_quality=Quality.ORANGE, is_complete_card=True),
        DetectedStarItem(source_image="main", source_position="r7c1", final_name="天府", final_level=1, final_quality=Quality.ORANGE, is_complete_card=False),
    ])
    assert state.apply_local_analysis(result) == 1
    assert [(row.name, row.level, row.quantity) for row in state.rows] == [("天府", 60, 1)]
    assert state.import_batch and state.import_batch.ocr_executed


def test_user_confirmed_pool_is_required_for_directed_overlap_marking() -> None:
    state = SessionState(load_catalog())
    first = ImageInput("main-a.jpg")
    second = ImageInput("main-b.jpg")
    state.add_uploaded_image(first)
    state.add_uploaded_image(second)
    state.set_image_pool(first.id, "main")
    state.set_image_pool(second.id, "main")
    state.add_overlap_pair("main", first.id, second.id)
    assert state.overlap_pairs["main"] == [(first.id, second.id)]
    state.set_image_pool(second.id, "support")
    assert state.overlap_pairs["main"] == []


def test_card_review_exclusion_and_manual_value_rebuild_only_affected_summary() -> None:
    state = SessionState(load_catalog())
    batch = ImportBatch(image_count=1, game_version=GameVersion.RU_YUAN, ocr_executed=True)
    result = AnalysisResult(executed=True, message="local", import_batch=batch, items=[
        DetectedStarItem(card_id="complete", source_image="image", source_position="r1c1", final_name="天府", final_level=1, final_quality=Quality.ORANGE, is_complete_card=True),
        DetectedStarItem(card_id="fragment", source_image="image", source_position="r7c1", final_name="天府", final_level=1, final_quality=Quality.ORANGE, is_complete_card=False),
    ])
    assert state.apply_local_analysis(result) == 1
    state.set_card_inventory_action("fragment", "exclude_fragment")
    state.update_detected_card("complete", name="武曲", level="60", quality="紫")
    assert [(row.name, row.level, row.quality, row.quantity) for row in state.rows] == [("武曲", 60, Quality.PURPLE, 1)]
    assert next(item for item in state.detected_items if item.card_id == "fragment").inventory_action == "exclude_fragment"


def test_unmarked_images_never_create_an_overlap_group_and_new_session_has_no_old_cache() -> None:
    assert LocalOfflineVisionPipeline._overlap_groups({}, {}, {}, {"image:r1c1": "card"}) == []
    fresh = SessionState(load_catalog())
    assert fresh.rows == []
    assert fresh.detected_items == []
    assert fresh.image_pools == {}
