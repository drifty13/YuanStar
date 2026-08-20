from nicegui import ui

from test_phase0_3_ui_contract_rebuild import fixture_state
from yuanstar.app import create_app
from yuanstar.vision.contracts import AnalysisResult


class SuccessfulPipeline:
    def analyze(self, images, batch, overlap_pairs, progress=None):
        if progress:
            progress(type("Progress", (), {
                "stage": "完成图片",
                "total_images": len(images),
                "completed_images": len(images),
                "current_image_index": len(images),
                "current_filename": images[-1].filename,
                "error_count": 0,
                "engine_initializations": 1,
                "detail": None,
            })())
        return AnalysisResult(
            executed=True,
            message="测试识别完成",
            items=[],
            import_batch=batch,
            image_pools={image.id: "main" for image in images},
        )


STATE = fixture_state()
STATE.confirm_all_image_pools()


def root() -> None:
    create_app(state=STATE, pipeline=SuccessfulPipeline())  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8095, show=False, reload=False)
