from __future__ import annotations

from pathlib import Path

from nicegui import ui

from yuanstar.accounts import AccountWorkspaceManager
from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.domain import InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState


CATALOG = load_catalog()
MANAGER = AccountWorkspaceManager(Path("output") / "phase0_5_1_restore_ui_workspace")
ACCOUNT = MANAGER.load_current(CATALOG).account
STORE = MANAGER.workspace_store(ACCOUNT.account_id)


def state_with_level(level: int) -> SessionState:
    state = SessionState(CATALOG)
    instance_id = state.add_row(InventorySummaryRow(
        kind=StarKind.MAIN,
        name="天府",
        quality=Quality.ORANGE,
        level=level,
        quantity=1,
    ))
    state.set_plan_level(instance_id, 60)
    return state


# Make the newest card deterministic on every test-server import, without
# deleting a user's unrelated workspace or review material.
STORE.save(state_with_level(40))
STORE.create_restore_point(state_with_level(10), reason="pre_ocr")


def root() -> None:
    create_app(pipeline=object(), account_workspace_manager=MANAGER)  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8108, show=False, reload=False)
