from __future__ import annotations

from pathlib import Path

from nicegui import ui

from yuanstar.accounts import AccountWorkspaceManager
from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.domain import GameVersion


MANAGER = AccountWorkspaceManager(Path("output") / "phase0_4_account_ui_workspace")
MANAGER.load_current(load_catalog())
SECOND_ACCOUNT = next(
    (account for account in MANAGER.accounts(load_catalog()) if account.display_name == "第二账号" and account.game_version == GameVersion.DAI_HAO_YUAN),
    None,
)
if SECOND_ACCOUNT is None:
    SECOND_ACCOUNT = MANAGER.create_account("第二账号", GameVersion.DAI_HAO_YUAN, load_catalog())
else:
    SECOND_ACCOUNT = MANAGER.update_account_metadata(
        SECOND_ACCOUNT.account_id,
        "第二账号",
        GameVersion.DAI_HAO_YUAN,
        load_catalog(),
    )


def root() -> None:
    create_app(pipeline=object(), account_workspace_manager=MANAGER)  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8104, show=False, reload=False)
