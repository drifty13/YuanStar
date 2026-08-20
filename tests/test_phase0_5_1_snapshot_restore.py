from copy import deepcopy
from pathlib import Path

import pytest

from yuanstar.accounts import AccountWorkspaceManager
from yuanstar.app import is_workspace_mutation_locked
from yuanstar.catalog import load_catalog
from yuanstar.domain import GameVersion, InventorySummaryRow, Quality, StarKind
from yuanstar.persistence import PreparedWorkspace, WorkspaceStore
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput


def make_row(level: int) -> InventorySummaryRow:
    return InventorySummaryRow(
        kind=StarKind.MAIN,
        name="天府",
        quality=Quality.ORANGE,
        level=level,
        quantity=1,
    )


def make_state(level: int) -> SessionState:
    state = SessionState(load_catalog())
    instance_id = state.add_row(make_row(level))
    state.set_plan_level(instance_id, 60)
    state.experience_quantities["橙星曜"] = 9
    state.uploaded_images = [ImageInput(id=f"image-{level}", filename=f"{level}.png", content=b"image")]
    state.image_pools = {f"image-{level}": "main"}
    state.image_audit = {f"image-{level}": {"manual": True}}
    return state


def test_restore_point_cards_are_account_local_sorted_and_legacy_compatible(tmp_path: Path) -> None:
    catalog = load_catalog()
    store_a = WorkspaceStore(tmp_path / "account-a" / "workspace")
    store_b = WorkspaceStore(tmp_path / "account-b" / "workspace")
    first = store_a.create_restore_point(make_state(10), reason="pre_ocr")
    second = store_a.create_restore_point(make_state(20), reason="pre_manual_restore")
    store_b.create_restore_point(make_state(30), reason="pre_ocr")
    (first / "restore-point.json").unlink()  # old point without a sidecar

    infos = store_a.list_restore_points(catalog)

    assert [item.inventory_count for item in infos] == [1, 1]
    assert [item.reason for item in infos] == ["pre_manual_restore", "pre_ocr"]
    assert infos[0].created_at >= infos[1].created_at
    assert infos[0].explicit_plan_count == 1
    assert infos[0].image_count == 1
    assert infos[0].has_ocr_result is True
    assert all(item.path.parent == store_a.restore_points_dir for item in infos)


def test_missing_images_warn_but_corrupt_workspace_cannot_be_restored(tmp_path: Path) -> None:
    catalog = load_catalog()
    store = WorkspaceStore(tmp_path / "workspace")
    missing_point = store.create_restore_point(make_state(10))
    next((missing_point / "images").iterdir()).unlink()
    corrupt_point = store.create_restore_point(make_state(20))
    (corrupt_point / "workspace.json").write_text("{broken", encoding="utf-8")

    infos = {item.path: item for item in store.list_restore_points(catalog)}

    assert infos[missing_point].readable is True
    assert infos[missing_point].missing_images == ("10.png",)
    assert infos[corrupt_point].readable is False
    assert "无法读取" in str(infos[corrupt_point].warning)
    assert not list(corrupt_point.glob("workspace.corrupt-*.json"))


def test_restore_list_reads_only_structured_summary_without_image_bytes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = load_catalog()
    store = WorkspaceStore(tmp_path / "workspace")
    point = store.create_restore_point(make_state(10))
    before = point.stat().st_mtime_ns

    def reject_image_read(self: Path) -> bytes:
        raise AssertionError(f"summary must not read image bytes: {self}")

    monkeypatch.setattr(Path, "read_bytes", reject_image_read)
    info = store.list_restore_points(catalog)[0]

    assert info.image_count == 1
    assert info.missing_images == ()
    assert point.stat().st_mtime_ns == before
    assert not list(point.glob("workspace.pre-plan-targets-*.json"))


def test_oldest_target_is_frozen_before_manual_safety_point_prunes_it(tmp_path: Path) -> None:
    catalog = load_catalog()
    store = WorkspaceStore(tmp_path / "workspace")
    for level in (10, 20, 30):
        store.create_restore_point(make_state(level))
    oldest = store.restore_point_paths()[0]

    target = store.prepare_restore_point(oldest, catalog)
    store.create_restore_point(store.prepare(make_state(50)), reason="pre_manual_restore")
    assert not oldest.exists()
    loaded = store.restore_prepared_workspace(target, catalog)

    assert loaded.state is not None
    assert loaded.state.rows[0].level == 10
    assert loaded.state.plan_targets[loaded.state.rows[0].star_instance_id] == 60
    assert loaded.state.experience_quantities["橙星曜"] == 9
    assert loaded.state.uploaded_images[0].content == b"image"
    # The restore transaction replaces workspace data without discarding the
    # restore-point collection that now contains the manual safety point.
    assert len(store.restore_point_paths()) == 3


def test_restore_staging_failure_keeps_current_disk_workspace_unchanged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = load_catalog()
    store = WorkspaceStore(tmp_path / "workspace")
    current = make_state(40)
    store.save(current)
    store.create_restore_point(current)
    target = store.prepare(make_state(10))

    def fail_copy(*args, **kwargs):
        raise OSError("simulated staging failure")

    monkeypatch.setattr("yuanstar.persistence.shutil.copytree", fail_copy)
    with pytest.raises(OSError, match="simulated staging failure"):
        store.restore_prepared_workspace(target, catalog)

    retained = store.load(catalog).state
    assert retained is not None
    assert retained.rows[0].level == 40
    assert not list(tmp_path.glob(".workspace.restore-stage-*"))


def test_restore_prepared_workspace_can_keep_current_account_identity(tmp_path: Path) -> None:
    catalog = load_catalog()
    store = WorkspaceStore(tmp_path / "workspace")
    target = store.prepare(make_state(10))
    snapshot = deepcopy(target.snapshot)
    snapshot["account_name"] = "当前账号"
    snapshot["game_version"] = "如鸢"

    result = store.restore_prepared_workspace(
        PreparedWorkspace(snapshot=snapshot, images=target.images), catalog,
    )

    assert result.state is not None
    assert result.state.account_name == "当前账号"
    assert result.state.game_version.value == "如鸢"


def test_restore_does_not_cross_account_or_roll_back_registered_identity(tmp_path: Path) -> None:
    catalog = load_catalog()
    manager = AccountWorkspaceManager(tmp_path / "YuanStar")
    first = manager.load_current(catalog).account
    second = manager.create_account("第二账号", GameVersion.DAI_HAO_YUAN, catalog)
    first_store = manager.workspace_store(first.account_id)
    second_store = manager.workspace_store(second.account_id)
    first_store.save(make_state(40))
    point = first_store.create_restore_point(make_state(10))
    second_store.save(make_state(30))

    prepared = first_store.prepare_restore_point(point, catalog)
    snapshot = deepcopy(prepared.snapshot)
    snapshot["account_name"] = first.display_name
    snapshot["game_version"] = first.game_version.value
    first_store.restore_prepared_workspace(
        PreparedWorkspace(snapshot=snapshot, images=prepared.images), catalog,
    )

    restored_first = manager.load_account(first.account_id, catalog)
    untouched_second = manager.load_account(second.account_id, catalog)
    assert restored_first.account.account_id == first.account_id
    assert restored_first.load_result.state is not None
    assert restored_first.load_result.state.rows[0].level == 10
    assert restored_first.load_result.state.account_name == first.display_name
    assert restored_first.load_result.state.game_version == first.game_version
    assert untouched_second.load_result.state is not None
    assert untouched_second.load_result.state.rows[0].level == 30


def test_restore_ui_uses_shared_expanding_cards_without_a_second_confirmation() -> None:
    source = Path("src/yuanstar/app.py").read_text(encoding="utf-8")
    assert 'def open_restore_dialog() -> None:' in source
    assert 'on_click=open_restore_dialog' in source
    assert 'icon="restore"' in source
    assert 'with ui.element("div").classes("import-primary-actions")' in source
    assert source.index('"恢复快照"') < source.index('"开始识别"')
    assert 'ui.expansion(' in source[source.index('def restore_dialog_content'):source.index('def open_restore_dialog')]
    assert '"恢复此快照"' in source
    assert '手动恢复前安全点' in source
    assert 'workspace_mutation_locked' in source


def test_restore_busy_locks_every_workspace_mutation_entry() -> None:
    assert is_workspace_mutation_locked(
        ocr_busy=False, restore_busy=True, task_status="idle", processing_uploads=False,
    )
    assert is_workspace_mutation_locked(
        ocr_busy=False, restore_busy=False, task_status="idle", processing_uploads=True,
    )
    assert not is_workspace_mutation_locked(
        ocr_busy=False, restore_busy=False, task_status="succeeded", processing_uploads=False,
    )


def test_restore_entry_references_and_summaries_are_bounded_and_cached() -> None:
    source = Path("src/yuanstar/app.py").read_text(encoding="utf-8")
    assert 'restore_entry_elements: dict[str, object | None] = {"import": None, "review": None}' in source
    assert 'restore_entry_elements["import"] = restore_button' in source
    assert 'restore_entry_elements["review"] = restore_action' in source
    assert "restore_entry_elements.append" not in source
    assert "restore_points_cache_key" in source
    assert "if fingerprint != restore_points_cache_key:" in source
    assert "restore_points_cache = workspace_store.list_restore_points(catalog)" in source
