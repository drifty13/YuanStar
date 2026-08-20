from __future__ import annotations

import json
from pathlib import Path

import pytest
from openpyxl import load_workbook

from yuanstar.accounts import AccountRegistryError, AccountWorkspaceManager
from yuanstar.catalog import load_catalog
from yuanstar.domain import GameVersion, InventorySummaryRow, Quality, StarKind
from yuanstar.export_excel import export_workbook
from yuanstar.persistence import WorkspaceStore
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput


def legacy_state() -> SessionState:
    state = SessionState(load_catalog())
    state.game_version = GameVersion.DAI_HAO_YUAN
    state.account_name = "旧账号"
    state.add_row(InventorySummaryRow(name="天府", kind=StarKind.MAIN, quality=Quality.ORANGE, level=60, quantity=1))
    state.save_experience(3, 4, 5)
    state.uploaded_images = [ImageInput(id="legacy-image", filename="legacy.png", content=b"image")]
    state.image_pools = {"legacy-image": "main"}
    state.confirmed_image_pools = {"legacy-image"}
    state.image_audit = {"legacy-image": {"manual": True}}
    return state


def test_legacy_workspace_migrates_once_with_backup_and_preserved_business_data(tmp_path: Path) -> None:
    manager = AccountWorkspaceManager(tmp_path / "YuanStar")
    old_store = WorkspaceStore(manager.legacy_workspace_root)
    original = legacy_state()
    old_store.save(original)

    loaded = manager.load_current(load_catalog())

    assert loaded.account.display_name == "旧账号"
    assert loaded.account.game_version == GameVersion.DAI_HAO_YUAN
    assert loaded.load_result.state is not None
    state = loaded.load_result.state
    assert state.rows[0].star_instance_id == original.rows[0].star_instance_id
    assert state.experience_quantities == original.experience_quantities
    assert state.image_audit == original.image_audit
    assert state.uploaded_images[0].content == b"image"
    assert manager.legacy_workspace_root.joinpath("workspace.json").exists()
    assert next((tmp_path / "YuanStar" / "migration-backups").iterdir()).joinpath("workspace.json").exists()

    again = manager.load_current(load_catalog())
    assert again.account.account_id == loaded.account.account_id
    assert len(manager.accounts(load_catalog())) == 1


def test_account_names_are_unique_per_game_and_rename_keeps_stable_id(tmp_path: Path) -> None:
    manager = AccountWorkspaceManager(tmp_path / "YuanStar")
    first = manager.load_current(load_catalog()).account
    with pytest.raises(ValueError, match="不能重复"):
        manager.create_account("默认账号", GameVersion.RU_YUAN, load_catalog())
    other_version = manager.create_account("默认账号", GameVersion.DAI_HAO_YUAN, load_catalog())
    with pytest.raises(ValueError, match="不能为空"):
        manager.create_account("  ", GameVersion.RU_YUAN, load_catalog())
    renamed = manager.rename_account(first.account_id, "已重命名", load_catalog())
    assert renamed.account_id == first.account_id
    assert renamed.game_version == first.game_version
    assert other_version.display_name == "默认账号"


def test_metadata_update_keeps_workspace_and_instance_ids(tmp_path: Path) -> None:
    catalog = load_catalog()
    manager = AccountWorkspaceManager(tmp_path / "YuanStar")
    account = manager.load_current(catalog).account
    state = legacy_state()
    state.account_name = account.display_name
    state.game_version = account.game_version
    manager.workspace_store(account.account_id).save(state)
    workspace_root = manager.workspace_store(account.account_id).root
    instance_id = state.rows[0].star_instance_id

    updated = manager.rename_account(
        account.account_id,
        "可编辑账号",
        catalog,
    )

    assert updated.account_id == account.account_id
    assert updated.game_version == account.game_version
    assert workspace_root == manager.workspace_store(account.account_id).root
    assert manager.load_account(account.account_id, catalog).load_result.state.rows[0].star_instance_id == instance_id
    other = manager.create_account("同名", GameVersion.RU_YUAN, catalog)
    with pytest.raises(ValueError, match="不能重复"):
        manager.rename_account(account.account_id, other.display_name, catalog)
    manager.create_account("可编辑账号", GameVersion.DAI_HAO_YUAN, catalog)
    with pytest.raises(ValueError, match="不能重复"):
        manager.update_account_metadata(
            account.account_id,
            "可编辑账号",
            GameVersion.DAI_HAO_YUAN,
            catalog,
        )
    assert manager.load_account(account.account_id, catalog).account.game_version == GameVersion.RU_YUAN
    version_changed = manager.update_account_metadata(
        account.account_id,
        "已切换版本",
        GameVersion.DAI_HAO_YUAN,
        catalog,
    )
    assert version_changed.account_id == account.account_id
    assert version_changed.game_version == GameVersion.DAI_HAO_YUAN
    assert workspace_root == manager.workspace_store(account.account_id).root
    assert manager.load_account(account.account_id, catalog).load_result.state.rows[0].star_instance_id == instance_id


def test_accounts_are_isolated_and_last_active_restores(tmp_path: Path) -> None:
    catalog = load_catalog()
    manager = AccountWorkspaceManager(tmp_path / "YuanStar")
    first = manager.load_current(catalog).account
    state_a = SessionState(catalog)
    state_a.account_name = first.display_name
    state_a.game_version = first.game_version
    state_a.save_experience(1, 2, 3)
    WorkspaceStore(manager.workspace_store(first.account_id).root).save(state_a)

    second = manager.create_account("第二账号", GameVersion.RU_YUAN, catalog)
    activated_b = manager.activate(second.account_id, catalog)
    state_b = activated_b.load_result.state
    assert state_b is not None
    assert state_b.experience_quantities == {"橙星曜": None, "紫星曜": None, "白星曜": None}
    state_b.save_experience(7, 8, 9)
    activated_b.workspace_store.save(state_b)

    activated_a = manager.activate(first.account_id, catalog)
    assert activated_a.load_result.state is not None
    assert activated_a.load_result.state.experience_quantities["橙星曜"] == 3
    final_b = manager.activate(second.account_id, catalog)
    assert final_b.load_result.state is not None
    assert final_b.load_result.state.experience_quantities["橙星曜"] == 9
    payload = json.loads(manager.registry_path.read_text(encoding="utf-8"))
    assert payload["last_active_account_id"] == second.account_id


def test_invalid_last_active_account_falls_back_without_creating_or_overwriting_workspace(tmp_path: Path) -> None:
    catalog = load_catalog()
    manager = AccountWorkspaceManager(tmp_path / "YuanStar")
    account = manager.load_current(catalog).account
    state = legacy_state()
    state.account_name = account.display_name
    state.game_version = account.game_version
    manager.workspace_store(account.account_id).save(state)
    original_workspace = manager.workspace_store(account.account_id).state_path.read_bytes()

    payload = json.loads(manager.registry_path.read_text(encoding="utf-8"))
    payload["current_account_id"] = "missing-account"
    payload["last_active_account_id"] = "missing-account"
    manager.registry_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    restored = AccountWorkspaceManager(manager.root).load_current(catalog)
    assert restored.account.account_id == account.account_id
    assert restored.warning is not None
    assert "恢复到可用账号" in restored.warning
    assert restored.load_result.state is not None
    assert restored.load_result.state.rows[0].star_instance_id == state.rows[0].star_instance_id
    assert manager.workspace_store(account.account_id).state_path.read_bytes() == original_workspace


def test_account_scoped_workspace_keeps_images_ocr_bag_and_export_identity_isolated(tmp_path: Path) -> None:
    catalog = load_catalog()
    root = tmp_path / "YuanStar"
    manager = AccountWorkspaceManager(root)
    first = manager.load_current(catalog).account
    state_a = SessionState(catalog)
    state_a.game_version = first.game_version
    state_a.account_name = first.display_name
    state_a.add_row(InventorySummaryRow(name="天府", kind=StarKind.MAIN, quality=Quality.ORANGE, level=60, quantity=1))
    state_a.save_bag_info(first.game_version, 23, 240, account_name=first.display_name)
    state_a.save_experience(3, 4, 5)
    state_a.uploaded_images = [ImageInput(id="image-a", filename="a.png", content=b"account-a")]
    state_a.image_pools = {"image-a": "main"}
    state_a.confirmed_image_pools = {"image-a"}
    state_a.image_audit = {"image-a": {"page_type": "main", "ocr": "A"}}
    manager.workspace_store(first.account_id).save(state_a)

    second = manager.create_account("账号 B", GameVersion.DAI_HAO_YUAN, catalog)
    loaded_b = manager.activate(second.account_id, catalog)
    state_b = loaded_b.load_result.state
    assert state_b is not None
    assert state_b.rows == []
    assert state_b.uploaded_images == []
    assert state_b.image_audit == {}
    assert state_b.bag_capacity is None
    state_b.add_row(InventorySummaryRow(name="解神", kind=StarKind.SUPPORT, quality=Quality.PURPLE, level=20, quantity=1))
    state_b.save_bag_info(second.game_version, 7, 180, account_name=second.display_name)
    state_b.save_experience(9, 8, 7)
    state_b.uploaded_images = [ImageInput(id="image-b", filename="b.png", content=b"account-b")]
    state_b.image_pools = {"image-b": "support"}
    state_b.confirmed_image_pools = {"image-b"}
    state_b.image_audit = {"image-b": {"page_type": "support", "ocr": "B"}}
    loaded_b.workspace_store.save(state_b)

    restored_a = manager.activate(first.account_id, catalog).load_result.state
    assert restored_a is not None
    assert [row.name for row in restored_a.rows] == ["天府"]
    assert restored_a.bag_capacity == 240
    assert restored_a.experience_quantities["橙星曜"] == 5
    assert [image.id for image in restored_a.uploaded_images] == ["image-a"]
    assert restored_a.image_audit["image-a"]["ocr"] == "A"

    manager.activate(second.account_id, catalog)
    restarted = AccountWorkspaceManager(root).load_current(catalog)
    assert restarted.account.account_id == second.account_id
    restored_b = restarted.load_result.state
    assert restored_b is not None
    assert [row.name for row in restored_b.rows] == ["解神"]
    assert restored_b.bag_capacity == 180
    assert restored_b.experience_quantities["橙星曜"] == 7
    assert [image.id for image in restored_b.uploaded_images] == ["image-b"]
    assert restored_b.image_audit["image-b"]["ocr"] == "B"

    destination = tmp_path / "account-b.xlsx"
    export_workbook(
        destination,
        restored_b.game_version,
        restored_b.account_name,
        restored_b.rows,
        restored_b.experience_resources(),
        restored_b.import_batch,
        catalog.order_index,
    )
    workbook = load_workbook(destination, data_only=True)
    assert workbook["背包汇总"][2][0].value == GameVersion.DAI_HAO_YUAN.value
    assert workbook["背包汇总"][2][1].value == "账号 B"


def test_bad_legacy_workspace_does_not_create_empty_account(tmp_path: Path) -> None:
    manager = AccountWorkspaceManager(tmp_path / "YuanStar")
    manager.legacy_workspace_root.mkdir(parents=True)
    manager.legacy_workspace_root.joinpath("workspace.json").write_text("{bad", encoding="utf-8")

    with pytest.raises(AccountRegistryError, match="无法安全迁移"):
        manager.load_current(load_catalog())

    assert not manager.registry_path.exists()
    assert manager.legacy_workspace_root.joinpath("workspace.json").read_text(encoding="utf-8") == "{bad"


def test_copy_failure_keeps_legacy_workspace_and_does_not_register_account(tmp_path: Path, monkeypatch) -> None:
    manager = AccountWorkspaceManager(tmp_path / "YuanStar")
    legacy = WorkspaceStore(manager.legacy_workspace_root)
    legacy.save(legacy_state())
    before = legacy.state_path.read_bytes()
    original_copytree = __import__("yuanstar.accounts", fromlist=["shutil"]).shutil.copytree
    calls = 0

    def fail_target_copy(source, destination, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("target copy failed")
        return original_copytree(source, destination, *args, **kwargs)

    monkeypatch.setattr("yuanstar.accounts.shutil.copytree", fail_target_copy)

    with pytest.raises(AccountRegistryError, match="迁移失败"):
        manager.load_current(load_catalog())

    assert legacy.state_path.read_bytes() == before
    assert not manager.registry_path.exists()
