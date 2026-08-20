from __future__ import annotations

from nicegui import ui

from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.domain import InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState


def fixture_state() -> SessionState:
    state = SessionState(load_catalog())
    for index in range(48):
        state.add_row(InventorySummaryRow(
            kind=StarKind.MAIN if index % 2 == 0 else StarKind.SUPPORT,
            name="天府" if index % 2 == 0 else "解神",
            quality=Quality.ORANGE if index % 3 else Quality.PURPLE,
            level=10 + index % 40,
            quantity=1,
            manual_status="专项测试",
        ))
    return state


def root() -> None:
    create_app(state=fixture_state(), pipeline=object())  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8105, show=False, reload=False)
