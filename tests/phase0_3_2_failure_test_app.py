from nicegui import ui

from test_phase0_3_ui_contract_rebuild import fixture_state
from yuanstar.app import create_app


class FailingPipeline:
    def analyze(self, images, batch, overlap_pairs, progress=None):
        raise RuntimeError("测试识别故障")


STATE = fixture_state()
STATE.confirm_all_image_pools()


def root() -> None:
    create_app(state=STATE, pipeline=FailingPipeline())  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8096, show=False, reload=False)
