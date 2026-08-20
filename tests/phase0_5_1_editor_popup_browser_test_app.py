from __future__ import annotations

import os

from nicegui import ui

from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.domain import InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState


def fixture_state() -> SessionState:
    state = SessionState(load_catalog())
    for index in range(12):
        state.add_row(InventorySummaryRow(
            kind=StarKind.MAIN,
            name="天府",
            quality=Quality.ORANGE,
            level=10 + index,
            quantity=1,
            manual_status="浏览器弹层专项",
        ))
    return state


def root() -> None:
    create_app(state=fixture_state(), pipeline=object())  # type: ignore[arg-type]


ui.run(
    root,
    host="127.0.0.1",
    port=int(os.environ["YUANSTAR_BROWSER_TEST_PORT"]),
    show=False,
    reload=False,
)
