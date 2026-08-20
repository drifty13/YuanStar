from __future__ import annotations

from pathlib import Path

import pytest
from yuanstar.catalog import load_catalog
from yuanstar.domain import DetectedStarItem
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput


ROOT = Path(__file__).resolve().parents[1]
APP_SOURCE = (ROOT / "src" / "yuanstar" / "app.py").read_text(encoding="utf-8")


def image(filename: str, *, missing: bool = False, content: bytes = b"image") -> ImageInput:
    return ImageInput(
        filename,
        width=1080,
        height=1920,
        content_type="image/png",
        content=content,
        missing=missing,
    )


def unknown_state(*filenames: str) -> tuple[SessionState, list[ImageInput]]:
    state = SessionState(load_catalog())
    images = [image(filename) for filename in filenames]
    for item in images:
        state.add_uploaded_image(item)
        state.suggest_image_pool(item.id, "unknown")
    return state, images


def test_unclassified_queue_is_ordered_and_ignores_stale_pool_entries() -> None:
    state, images = unknown_state("one.png", "two.png")
    state.image_pools["stale-id"] = "unknown"
    state.image_pools.pop(images[1].id)

    assert state.unclassified_images() == images


@pytest.mark.parametrize("pool", ["main", "support", "experience"])
def test_manual_route_updates_real_state_and_recognition_input(pool: str) -> None:
    state, [source] = unknown_state(f"{pool}.png")
    state.image_audit[source.id] = {"page_type": "unknown", "warning": "kept"}
    state.detected_items = [
        DetectedStarItem(
            card_id="card",
            source_image=source.id,
            source_position="r1c1",
            page_type="unknown",
        )
    ]

    routed = state.route_unclassified_image(source.id, pool)

    assert routed is source
    assert state.unclassified_images() == []
    assert state.image_pools[source.id] == pool
    assert source.id in state.confirmed_image_pools
    assert state.image_audit[source.id] == {"page_type": pool, "warning": "kept"}
    assert state.detected_items[0].page_type == pool
    assert state.uploaded_images == [source]
    assert state.start_import("代号鸢", None, None).image_count == 1


def test_duplicate_or_unreadable_route_keeps_queue_and_other_confirmations() -> None:
    state, [source] = unknown_state("unknown.png")
    confirmed = image("confirmed.png")
    state.add_uploaded_image(confirmed)
    state.set_image_pool(confirmed.id, "main")

    with pytest.raises(ValueError, match="未找到待分流图片"):
        state.route_unclassified_image("missing-id", "main")
    with pytest.raises(ValueError, match="请选择主星池"):
        state.route_unclassified_image(source.id, "unknown")

    state.route_unclassified_image(source.id, "support")
    with pytest.raises(ValueError, match="已由其他操作完成分流"):
        state.route_unclassified_image(source.id, "main")
    assert state.image_pools[source.id] == "support"
    assert confirmed.id in state.confirmed_image_pools

    unreadable = image("missing.png", missing=True, content=b"")
    state.add_uploaded_image(unreadable)
    with pytest.raises(ValueError, match="暂时不可读取"):
        state.route_unclassified_image(unreadable.id, "experience")
    assert state.unclassified_images() == [unreadable]
    assert unreadable.id not in state.confirmed_image_pools


def test_failed_route_rolls_back_every_changed_field(monkeypatch: pytest.MonkeyPatch) -> None:
    state, [source] = unknown_state("rollback.png")
    state.image_audit[source.id] = {"page_type": "unknown"}
    state.detected_items = [
        DetectedStarItem(
            card_id="rollback-card",
            source_image=source.id,
            source_position="r1c1",
            page_type="unknown",
        )
    ]
    state.selected_import_image_id = source.id
    before = state.snapshot()

    def fail_recalculate() -> None:
        raise RuntimeError("forced route failure")

    monkeypatch.setattr(state, "recalculate_postprocess", fail_recalculate)
    with pytest.raises(RuntimeError, match="forced route failure"):
        state.route_unclassified_image(source.id, "main")

    assert state.snapshot() == before
    assert state.selected_import_image_id == source.id
    assert state.unclassified_images() == [source]


def test_manual_routing_ui_contract_precedes_existing_three_pools_without_css_changes() -> None:
    routing = APP_SOURCE.index('mark("unclassified-manual-routing")')
    pools = APP_SOURCE.index('mark("image-pools-5-5-3")')
    assert routing < pools
    assert '"无法自动分流图片"' in APP_SOURCE
    assert '"分流到：请选择目标池"' in APP_SOURCE
    assert '"experience": "经验星曜池"' in APP_SOURCE
    assert 'mark("unclassified-view-image")' in APP_SOURCE
    assert '"unclassified-routing-target"' in APP_SOURCE
    assert APP_SOURCE.count("scrollIntoView({block:'nearest', behavior:'smooth'})") == 1
    assert '"unclassified_focus_claimed"' in APP_SOURCE
    assert ".image-pools-grid {" in APP_SOURCE
    assert "grid-template-columns: minmax(0, 5fr) minmax(0, 5fr) minmax(0, 3fr);" in APP_SOURCE
    assert ".pool-zone { min-width: 0; height: 18rem; max-height: 18rem;" in APP_SOURCE


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/unclassified_manual_routing_test_app.py")
async def test_manual_routing_ui_advances_hides_and_keeps_ocr_idle(user) -> None:
    await user.open("/")
    await user.should_see(marker="unclassified-manual-routing")
    await user.should_see("无法自动分流图片")
    await user.should_see("unknown-a.png")
    await user.should_see("第 1 / 2 张")
    await user.should_see(marker="unclassified-view-image")
    await user.should_see(marker="unclassified-routing-target")

    user.find(marker="start-import").click()
    user.find(marker="confirm-start-import").click()
    await user.should_see("请先处理“无法自动分流图片”区的全部图片")

    user.find(marker="unclassified-view-image").click()
    await user.should_see(marker="full-viewer-close")
    user.find(marker="full-viewer-close").click()

    user.find(marker="unclassified-routing-target").trigger(
        "update:modelValue",
        {"value": 0, "label": "主星池"},
    )
    await user.should_see("unknown-b.png")
    await user.should_see("第 1 / 1 张")
    await user.should_see("主星池（2 张）")
    await user.should_see("已确认")

    user.find(marker="unclassified-routing-target").trigger(
        "update:modelValue",
        {"value": 1, "label": "辅星池"},
    )
    await user.should_not_see(marker="unclassified-manual-routing")
    await user.should_see("辅星池（1 张）")
    await user.should_see("任务状态：等待开始")
