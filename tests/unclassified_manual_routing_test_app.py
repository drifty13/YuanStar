from nicegui import ui

from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput


STATE = SessionState(load_catalog())
for filename in ("unknown-a.png", "unknown-b.png"):
    image = ImageInput(
        filename,
        width=1080,
        height=1920,
        content_type="image/png",
        content=b"local-test-image",
    )
    STATE.add_uploaded_image(image)
    STATE.suggest_image_pool(image.id, "unknown")

confirmed = ImageInput(
    "confirmed-main.png",
    width=1080,
    height=1920,
    content_type="image/png",
    content=b"local-test-image",
)
STATE.add_uploaded_image(confirmed)
STATE.set_image_pool(confirmed.id, "main")


def root() -> None:
    create_app(state=STATE, pipeline=object())  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8093, show=False, reload=False)
