import cv2
import numpy as np
from nicegui import ui

from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput


STATE = SessionState(load_catalog())
_, ENCODED = cv2.imencode(".png", np.zeros((8, 8, 3), dtype=np.uint8))
PNG = ENCODED.tobytes()
STATE.uploaded_images = [
    ImageInput(
        id="one",
        filename="one.png",
        content=PNG,
        content_type="image/png",
        missing=False,
    ),
    ImageInput(
        id="two",
        filename="two.png",
        content=PNG,
        content_type="image/png",
        missing=False,
    ),
]
STATE.image_pools = {"one": "main", "two": "support"}
STATE.selected_import_image_id = "one"


def root() -> None:
    create_app(state=STATE)


ui.run(root, host="127.0.0.1", port=8099, show=False, reload=False)
