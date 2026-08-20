from __future__ import annotations

import struct

from .contracts import ImageInput


def image_dimensions(data: bytes) -> tuple[int | None, int | None]:
    """Read common image dimensions without persisting user screenshots."""
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data.startswith(b"\xff\xd8"):
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                break
            marker = data[index + 1]
            index += 2
            if marker in {0xD8, 0xD9}:
                continue
            length = int.from_bytes(data[index:index + 2], "big")
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                return int.from_bytes(data[index + 5:index + 7], "big"), int.from_bytes(data[index + 3:index + 5], "big")
            index += length
    return None, None


def image_input_from_upload(
    filename: str, data: bytes, content_type: str | None = None
) -> ImageInput:
    """Build an in-memory input only after a supported image can be inspected."""
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in {"png", "jpg", "jpeg"}:
        raise ValueError("仅支持 PNG、JPG 或 JPEG 图片。")
    width, height = image_dimensions(data)
    if not width or not height:
        raise ValueError("无法读取图片尺寸，请上传有效的 PNG、JPG 或 JPEG 图片。")
    return ImageInput(
        filename=filename,
        width=width,
        height=height,
        size_bytes=len(data),
        content_type=content_type,
        content=data,
    )
