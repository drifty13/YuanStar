import cv2
import numpy as np
from nicegui import ui

from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput


STATE = SessionState(load_catalog())
image = np.full((900, 600, 3), (34, 35, 55), dtype=np.uint8)
cv2.putText(
    image,
    "EXPERIENCE",
    (95, 430),
    cv2.FONT_HERSHEY_SIMPLEX,
    1.2,
    (230, 230, 240),
    3,
    cv2.LINE_AA,
)
_, encoded = cv2.imencode(".png", image)
STATE.uploaded_images = [
    ImageInput(
        id="experience-one",
        filename="experience-current.png",
        width=600,
        height=900,
        content=encoded.tobytes(),
        content_type="image/png",
    )
]
STATE.image_pools = {"experience-one": "experience"}
STATE.confirmed_image_pools = {"experience-one"}
STATE.experience_quantities = {"橙星曜": 1, "紫星曜": 77, "白星曜": 14}


def root() -> None:
    create_app(state=STATE)


ui.run(root, host="127.0.0.1", port=8102, show=False, reload=False)
