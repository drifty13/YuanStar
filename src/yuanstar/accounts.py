from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
from typing import Any
from uuid import uuid4

from .catalog import StarCatalog
from .domain import GameVersion
from .persistence import WorkspaceLoadResult, WorkspaceStore
from .session import SessionState


ACCOUNT_REGISTRY_SCHEMA_VERSION = 1


class AccountRegistryError(RuntimeError):
    """The local account registry is invalid or cannot be safely migrated."""


@dataclass(frozen=True)
class LocalAccount:
    account_id: str
    display_name: str
    game_version: GameVersion
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class AccountWorkspaceLoad:
    account: LocalAccount
    workspace_store: WorkspaceStore
    load_result: WorkspaceLoadResult
    warning: str | None = None


class AccountWorkspaceManager:
    """Owns the local account registry and account-scoped JSON workspaces.

    The old ``workspace/`` directory is intentionally left in place after a
    successful migration so a user can recover it manually if needed.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.registry_path = self.root / "accounts.json"
        self.accounts_root = self.root / "accounts"
        self.legacy_workspace_root = self.root / "workspace"

    @classmethod
    def default(cls) -> "AccountWorkspaceManager":
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        return cls(base / "YuanStar")

    def workspace_store(self, account_id: str) -> WorkspaceStore:
        return WorkspaceStore(self.accounts_root / account_id / "workspace")

    def load_current(self, catalog: StarCatalog) -> AccountWorkspaceLoad:
        accounts, current_id, warning = self._load_or_initialize(catalog)
        loaded = self._load_account_from_accounts(accounts, current_id, catalog)
        return replace(loaded, warning=warning)

    def load_account(self, account_id: str, catalog: StarCatalog) -> AccountWorkspaceLoad:
        """Read a target account before making it the startup account."""
        accounts, _, _ = self._load_or_initialize(catalog)
        return self._load_account_from_accounts(accounts, account_id, catalog)

    def _load_account_from_accounts(
        self, accounts: list[LocalAccount], account_id: str, catalog: StarCatalog,
    ) -> AccountWorkspaceLoad:
        account = next((candidate for candidate in accounts if candidate.account_id == account_id), None)
        if account is None:
            raise AccountRegistryError("未找到目标本机账号")
        store = self.workspace_store(account.account_id)
        result = store.load(catalog)
        state = result.state or SessionState(catalog)
        # The registry is canonical for identity.  This also repairs the small
        # legacy fields in-memory after a rename without ever moving files.
        state.game_version = account.game_version
        state.account_name = account.display_name
        result = replace(result, state=state)
        return AccountWorkspaceLoad(account, store, result)

    def accounts(self, catalog: StarCatalog) -> tuple[LocalAccount, ...]:
        accounts, _, _ = self._load_or_initialize(catalog)
        return tuple(accounts)

    def create_account(self, display_name: str, game_version: GameVersion | str, catalog: StarCatalog) -> LocalAccount:
        accounts, _, _ = self._load_or_initialize(catalog)
        name = self._validate_name(display_name)
        version = GameVersion(game_version)
        self._ensure_unique_name(accounts, name, version)
        now = self._now()
        account = LocalAccount(uuid4().hex, name, version, now, now)
        self._write_registry([*accounts, account], account.account_id)
        return account

    def rename_account(self, account_id: str, display_name: str, catalog: StarCatalog) -> LocalAccount:
        accounts, current_id, _ = self._load_or_initialize(catalog)
        existing = next((account for account in accounts if account.account_id == account_id), None)
        if existing is None:
            raise AccountRegistryError("未找到本机账号")
        name = self._validate_name(display_name)
        self._ensure_unique_name(accounts, name, existing.game_version, excluding=account_id)
        updated = replace(existing, display_name=name, updated_at=self._now())
        self._write_registry(
            [updated if account.account_id == account_id else account for account in accounts],
            current_id,
        )
        return updated

    def update_account_metadata(
        self,
        account_id: str,
        display_name: str,
        game_version: GameVersion | str,
        catalog: StarCatalog,
        *,
        accounts: list[LocalAccount] | None = None,
        current_id: str | None = None,
    ) -> LocalAccount:
        """Update account identity metadata without moving its workspace."""
        if accounts is None or current_id is None:
            accounts, current_id, _ = self._load_or_initialize(catalog)
        version = GameVersion(game_version)
        existing = next((account for account in accounts if account.account_id == account_id), None)
        if existing is None:
            raise AccountRegistryError("未找到本机账号")
        name = self._validate_name(display_name)
        self._ensure_unique_name(accounts, name, version, excluding=account_id)
        updated = replace(
            existing,
            display_name=name,
            game_version=version,
            updated_at=self._now(),
        )
        self._write_registry(
            [updated if account.account_id == account_id else account for account in accounts],
            current_id,
        )
        return updated

    def activate(self, account_id: str, catalog: StarCatalog) -> AccountWorkspaceLoad:
        accounts, _, _ = self._load_or_initialize(catalog)
        loaded = self._load_account_from_accounts(accounts, account_id, catalog)
        self._write_registry(accounts, account_id)
        return loaded

    def _load_or_initialize(self, catalog: StarCatalog) -> tuple[list[LocalAccount], str, str | None]:
        if self.registry_path.exists():
            accounts, requested_id = self._read_registry()
            current_id = requested_id if any(account.account_id == requested_id for account in accounts) else accounts[0].account_id
            warning = None
            if current_id != requested_id:
                self._write_registry(accounts, current_id)
                warning = "上次使用的本机账号不存在，已恢复到可用账号。"
            return accounts, current_id, warning
        return self._migrate_or_initialize(catalog)

    def _migrate_or_initialize(self, catalog: StarCatalog) -> tuple[list[LocalAccount], str, str | None]:
        legacy = WorkspaceStore(self.legacy_workspace_root)
        if legacy.state_path.exists():
            # Do not create an empty profile if the old data cannot be read.
            result = legacy.load(catalog)
            if result.state is None:
                raise AccountRegistryError(
                    "旧工作区无法安全迁移；原文件已保留，请先处理旧工作区恢复提示。"
                )
            if self.accounts_root.exists() and any(self.accounts_root.iterdir()):
                raise AccountRegistryError("检测到未完成的账号迁移材料；为避免覆盖，已停止启动。")
            state = result.state
            now = self._now()
            account = LocalAccount(
                uuid4().hex,
                self._legacy_name(state.account_name),
                state.game_version,
                now,
                now,
            )
            backup_root = self.root / "migration-backups" / f"workspace-{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            target_root = self.workspace_store(account.account_id).root
            try:
                backup_root.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(self.legacy_workspace_root, backup_root)
                shutil.copytree(self.legacy_workspace_root, target_root)
                self._write_registry([account], account.account_id)
            except Exception as error:
                # Legacy data is never modified; a partial new directory is retained
                # for diagnosis rather than deleting anything automatically.
                raise AccountRegistryError(f"旧工作区迁移失败，原工作区未改变：{error}") from error
            return [account], account.account_id, "已将原本机工作区迁移为第一个账号，并保留迁移前备份。"

        now = self._now()
        account = LocalAccount(uuid4().hex, "默认账号", GameVersion.RU_YUAN, now, now)
        self._write_registry([account], account.account_id)
        return [account], account.account_id, None

    def _read_registry(self) -> tuple[list[LocalAccount], str]:
        try:
            payload = json.loads(self.registry_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("schema_version") != ACCOUNT_REGISTRY_SCHEMA_VERSION:
                raise ValueError("注册表版本不受支持")
            raw_accounts = payload.get("accounts")
            if not isinstance(raw_accounts, list) or not raw_accounts:
                raise ValueError("账号列表为空")
            accounts = [self._parse_account(raw) for raw in raw_accounts]
            if len({account.account_id for account in accounts}) != len(accounts):
                raise ValueError("账号标识重复")
            for account in accounts:
                self._ensure_unique_name(accounts, account.display_name, account.game_version, excluding=account.account_id)
            requested_id = str(payload.get("last_active_account_id") or payload.get("current_account_id") or "")
            return accounts, requested_id
        except AccountRegistryError:
            raise
        except Exception as error:
            raise AccountRegistryError(f"本机账号注册表无法读取，未修改任何数据：{error}") from error

    def _write_registry(self, accounts: list[LocalAccount], current_id: str) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": ACCOUNT_REGISTRY_SCHEMA_VERSION,
            "current_account_id": current_id,
            "last_active_account_id": current_id,
            "accounts": [
                {
                    "account_id": account.account_id,
                    "display_name": account.display_name,
                    "game_version": account.game_version.value,
                    "created_at": account.created_at,
                    "updated_at": account.updated_at,
                }
                for account in accounts
            ],
        }
        temporary = self.registry_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.registry_path)

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _legacy_name(value: str) -> str:
        return str(value or "").strip()[:80] or "默认账号"

    @staticmethod
    def _validate_name(value: str) -> str:
        name = str(value or "").strip()[:80]
        if not name:
            raise ValueError("账号名称不能为空")
        return name

    @staticmethod
    def _ensure_unique_name(
        accounts: list[LocalAccount], name: str, version: GameVersion, *, excluding: str | None = None,
    ) -> None:
        if any(
            account.account_id != excluding and account.game_version == version and account.display_name == name
            for account in accounts
        ):
            raise ValueError("同一游戏版本内账号名称不能重复")

    @staticmethod
    def _parse_account(raw: Any) -> LocalAccount:
        if not isinstance(raw, dict):
            raise ValueError("账号记录不是对象")
        account_id = str(raw.get("account_id") or "")
        if not account_id:
            raise ValueError("账号标识缺失")
        return LocalAccount(
            account_id=account_id,
            display_name=AccountWorkspaceManager._validate_name(str(raw.get("display_name") or "")),
            game_version=GameVersion(raw.get("game_version")),
            created_at=str(raw.get("created_at") or ""),
            updated_at=str(raw.get("updated_at") or ""),
        )
