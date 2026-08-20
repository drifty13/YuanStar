from __future__ import annotations

import os

from nicegui import ui


def root() -> None:
    rows = [{"id": index, "name": f"实例 {index}", "level": index + 1} for index in range(120)]
    table = ui.table(
        columns=[
            {"name": "name", "label": "名称", "field": "name", "align": "left"},
            {"name": "level", "label": "等级", "field": "level", "align": "right"},
        ],
        rows=rows,
        row_key="id",
    ).props("virtual-scroll table-style=height:180px id=yuanstar-browser-virtual-table")
    ui.button(
        "定位第 100 行",
        on_click=lambda: table.run_method("scrollTo", 100),
    ).props("id=yuanstar-browser-scroll-to")


ui.run(
    root,
    host="127.0.0.1",
    port=int(os.environ["YUANSTAR_BROWSER_TEST_PORT"]),
    show=False,
    reload=False,
)
