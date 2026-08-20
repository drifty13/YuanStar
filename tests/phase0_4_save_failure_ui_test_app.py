from __future__ import annotations

from pathlib import Path

from nicegui import ui

from yuanstar.accounts import AccountWorkspaceManager
from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.domain import GameVersion
from yuanstar.persistence import WorkspaceStore


class FailingWorkspaceStore(WorkspaceStore):
    def save(self, state):  # type: ignore[override]
        raise OSError("test save failure")


MANAGER = AccountWorkspaceManager(Path("output") / "phase0_4_save_failure_ui_workspace")
MANAGER.load_current(load_catalog())
CURRENT_ACCOUNT = next(
    account for account in MANAGER.accounts(load_catalog()) if account.display_name == "默认账号"
)
MANAGER.activate(CURRENT_ACCOUNT.account_id, load_catalog())
SECOND_ACCOUNT = next(
    (account for account in MANAGER.accounts(load_catalog()) if account.display_name == "保存失败目标"),
    None,
)
if SECOND_ACCOUNT is None:
    SECOND_ACCOUNT = MANAGER.create_account("保存失败目标", GameVersion.DAI_HAO_YUAN, load_catalog())
_original_workspace_store = MANAGER.workspace_store


def failing_current_store(account_id: str) -> WorkspaceStore:
    store = _original_workspace_store(account_id)
    return FailingWorkspaceStore(store.root) if account_id == CURRENT_ACCOUNT.account_id else store


MANAGER.workspace_store = failing_current_store  # type: ignore[method-assign]


def root() -> None:
    create_app(pipeline=object(), account_workspace_manager=MANAGER)  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8105, show=False, reload=False)
