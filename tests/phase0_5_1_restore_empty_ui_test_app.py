from __future__ import annotations

from pathlib import Path

from nicegui import ui

from yuanstar.accounts import AccountWorkspaceManager
from yuanstar.app import create_app


MANAGER = AccountWorkspaceManager(Path("output") / "phase0_5_1_restore_empty_ui_workspace")


def root() -> None:
    create_app(pipeline=object(), account_workspace_manager=MANAGER)  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8109, show=False, reload=False)
