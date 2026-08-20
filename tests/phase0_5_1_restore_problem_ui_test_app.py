from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from nicegui import ui

from yuanstar.accounts import AccountWorkspaceManager
from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.domain import InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput


CATALOG = load_catalog()
MANAGER = AccountWorkspaceManager(Path("output") / "phase0_5_1_restore_problem_ui_workspace")
ACCOUNT = MANAGER.create_account(f"恢复状态测试-{uuid4().hex[:8]}", "如鸢", CATALOG)
MANAGER.activate(ACCOUNT.account_id, CATALOG)
STORE = MANAGER.workspace_store(ACCOUNT.account_id)


def state_with_image(level: int) -> SessionState:
    state = SessionState(CATALOG)
    state.add_row(InventorySummaryRow(
        kind=StarKind.MAIN,
        name="天府",
        quality=Quality.ORANGE,
        level=level,
        quantity=1,
    ))
    state.uploaded_images = [ImageInput(id=f"image-{level}", filename=f"{level}.png", content=b"image")]
    return state


missing_point = STORE.create_restore_point(state_with_image(10))
next((missing_point / "images").iterdir()).unlink()
corrupt_point = STORE.create_restore_point(state_with_image(20))
(corrupt_point / "workspace.json").write_text("{broken", encoding="utf-8")


def root() -> None:
    create_app(pipeline=object(), account_workspace_manager=MANAGER)  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8110, show=False, reload=False)
