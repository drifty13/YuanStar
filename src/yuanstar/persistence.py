from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import shutil
from threading import Lock
from typing import Any
from uuid import uuid4

from .catalog import StarCatalog
from .session import SessionState
from .vision.contracts import ImageInput


WORKSPACE_SCHEMA_VERSION = 1
RESTORE_POINT_SCHEMA_VERSION = 1
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WorkspaceLoadResult:
    state: SessionState | None
    warning: str | None = None
    corrupt_backup: Path | None = None
    missing_images: tuple[str, ...] = ()


@dataclass(frozen=True)
class WorkspaceStorageSizes:
    structured_bytes: int
    image_bytes: int

    @property
    def total_bytes(self) -> int:
        return self.structured_bytes + self.image_bytes


@dataclass(frozen=True)
class PreparedWorkspace:
    snapshot: dict[str, Any]
    images: tuple[ImageInput, ...]
    revision: int | None = None


@dataclass(frozen=True)
class RestorePointInfo:
    """A safe, display-ready summary of one account-local restore point."""

    path: Path
    created_at: datetime
    reason: str
    inventory_count: int
    image_count: int
    explicit_plan_count: int
    has_ocr_result: bool
    readable: bool
    missing_images: tuple[str, ...] = ()
    warning: str | None = None


class WorkspaceStore:
    """Atomic JSON persistence for the single most recent local workspace."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.state_path = self.root / "workspace.json"
        self.image_dir = self.root / "images"
        self.restore_points_dir = self.root / "restore-points"
        self._write_lock = Lock()
        self._latest_revision = -1

    @classmethod
    def default(cls) -> "WorkspaceStore":
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        return cls(base / "YuanStar" / "workspace")

    @staticmethod
    def _image_suffix(image: ImageInput) -> str:
        content_type = (image.content_type or "").lower()
        if content_type == "image/png":
            return ".png"
        if content_type in {"image/jpeg", "image/jpg"}:
            return ".jpg"
        suffix = Path(image.filename).suffix.lower()
        return suffix if suffix in {".png", ".jpg", ".jpeg"} else ".img"

    @staticmethod
    def prepare(
        state: SessionState,
        *,
        revision: int | None = None,
    ) -> PreparedWorkspace:
        """Capture a coherent business snapshot on the UI thread."""
        snapshot = state.snapshot()
        snapshot.pop("uploaded_image_metadata", None)
        image_audit = snapshot.get("image_audit")
        if isinstance(image_audit, dict):
            for audit in image_audit.values():
                if isinstance(audit, dict):
                    audit.pop("preview_data_url", None)
        return PreparedWorkspace(
            snapshot=snapshot,
            images=tuple(state.uploaded_images),
            revision=revision,
        )

    def save(
        self,
        state: SessionState | PreparedWorkspace,
    ) -> WorkspaceStorageSizes:
        prepared = state if isinstance(state, PreparedWorkspace) else self.prepare(state)
        with self._write_lock:
            if (
                prepared.revision is not None
                and prepared.revision < self._latest_revision
            ):
                return self.storage_sizes()
            self.root.mkdir(parents=True, exist_ok=True)
            self.image_dir.mkdir(parents=True, exist_ok=True)
            image_records: list[dict[str, Any]] = []
            retained_names: set[str] = set()
            for image in prepared.images:
                stored_name = f"{image.id}{self._image_suffix(image)}"
                retained_names.add(stored_name)
                destination = self.image_dir / stored_name
                content_size = len(image.content)
                needs_copy = (
                    bool(image.content)
                    and (
                        not destination.exists()
                        or destination.stat().st_size != content_size
                    )
                )
                if needs_copy:
                    temporary = destination.with_suffix(destination.suffix + ".tmp")
                    temporary.write_bytes(image.content)
                    temporary.replace(destination)
                image_records.append({
                    "id": image.id,
                    "filename": image.filename,
                    "width": image.width,
                    "height": image.height,
                    "size_bytes": image.size_bytes or content_size,
                    "content_type": image.content_type,
                    "stored_path": f"images/{stored_name}",
                    "missing": bool(image.missing or not destination.exists()),
                })

            payload = {
                "schema_version": WORKSPACE_SCHEMA_VERSION,
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "state": prepared.snapshot,
                "images": image_records,
            }
            temporary_state = self.state_path.with_suffix(".json.tmp")
            temporary_state.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temporary_state.replace(self.state_path)

            for path in self.image_dir.iterdir():
                if path.is_file() and path.name not in retained_names and not path.name.endswith(".tmp"):
                    path.unlink()
            if prepared.revision is not None:
                self._latest_revision = max(
                    self._latest_revision,
                    prepared.revision,
                )
            return self.storage_sizes()

    def load(
        self,
        catalog: StarCatalog,
        *,
        backup_corrupt: bool = True,
    ) -> WorkspaceLoadResult:
        if not self.state_path.exists():
            return WorkspaceLoadResult(state=None)
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("工作区索引不是 JSON 对象")
            if payload.get("schema_version") != WORKSPACE_SCHEMA_VERSION:
                raise ValueError("工作区数据版本不受支持")
            snapshot = payload.get("state")
            if not isinstance(snapshot, dict):
                raise ValueError("工作区状态缺失")
            # Phase 0.4 workspaces have no plan overlay.  Keep a byte-for-byte
            # safety copy before their next ordinary autosave writes the new
            # field; no account directory is moved or recreated.
            if "plan_targets" not in snapshot:
                self._backup_pre_plan_migration()
            state = SessionState(catalog)
            state.restore(snapshot)
        except Exception as error:
            backup = self._backup_corrupt_state() if backup_corrupt else None
            return WorkspaceLoadResult(
                state=None,
                warning=f"上次工作区无法完整恢复：{error}",
                corrupt_backup=backup,
            )

        missing: list[str] = []
        restored_images: list[ImageInput] = []
        for record in payload.get("images", []):
            if not isinstance(record, dict) or not record.get("id"):
                continue
            relative = Path(str(record.get("stored_path") or ""))
            source = self.root / relative
            content = b""
            is_missing = True
            try:
                resolved_source = source.resolve()
                if self.root.resolve() in resolved_source.parents and source.is_file():
                    content = source.read_bytes()
                    is_missing = False
            except OSError:
                is_missing = True
            if is_missing:
                missing.append(str(record.get("filename") or record["id"]))
            restored_images.append(ImageInput(
                id=str(record["id"]),
                filename=str(record.get("filename") or record["id"]),
                width=record.get("width"),
                height=record.get("height"),
                size_bytes=int(record.get("size_bytes") or len(content)),
                content_type=record.get("content_type"),
                content=content,
                missing=is_missing,
            ))
        state.uploaded_images = restored_images
        state.reset_transient_ui_state()
        warning = None
        if missing:
            warning = "部分工作区图片文件缺失，相关记录已保留并明确标记。"
        return WorkspaceLoadResult(
            state=state,
            warning=warning,
            missing_images=tuple(missing),
        )

    def storage_sizes(self) -> WorkspaceStorageSizes:
        structured = self.state_path.stat().st_size if self.state_path.exists() else 0
        images = sum(
            path.stat().st_size
            for path in self.image_dir.iterdir()
            if path.is_file() and not path.name.endswith(".tmp")
        ) if self.image_dir.exists() else 0
        return WorkspaceStorageSizes(structured_bytes=structured, image_bytes=images)

    def create_restore_point(
        self,
        state: PreparedWorkspace | SessionState,
        *,
        reason: str = "pre_ocr",
    ) -> Path:
        """Persist a complete, account-local OCR recovery point before replacement.

        Restore points are intentionally file copies of the ordinary workspace
        schema, including images, so they can recover every persisted field
        without guessing instance matches.  Only the newest three are kept.
        """
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        point = self.restore_points_dir / f"auto-{stamp}-{uuid4().hex[:8]}"
        try:
            point_store = WorkspaceStore(point)
            prepared = state if isinstance(state, PreparedWorkspace) else self.prepare(state)
            point_store.save(prepared)
            (point / "restore-point.json").write_text(
                json.dumps(
                    {
                        "schema_version": RESTORE_POINT_SCHEMA_VERSION,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "reason": reason,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            self.restore_points_dir.mkdir(parents=True, exist_ok=True)
            points = sorted(
                (path for path in self.restore_points_dir.iterdir() if path.is_dir() and path.name.startswith("auto-")),
                key=lambda path: path.name,
            )
            for stale in points[:-3]:
                shutil.rmtree(stale)
            return point
        except Exception:
            # Do not leave a partial restore point looking usable.
            if point.exists():
                shutil.rmtree(point, ignore_errors=True)
            raise

    def restore_point_paths(self) -> tuple[Path, ...]:
        if not self.restore_points_dir.exists():
            return ()
        return tuple(sorted(
            (path for path in self.restore_points_dir.iterdir() if path.is_dir() and path.name.startswith("auto-")),
            key=lambda path: path.name,
        ))

    def list_restore_points(self, catalog: StarCatalog) -> tuple[RestorePointInfo, ...]:
        """Read only this store's newest three points without mutating them."""
        infos = [self._restore_point_info(path, catalog) for path in self.restore_point_paths()]
        return tuple(sorted(infos, key=lambda item: item.created_at, reverse=True)[:3])

    def prepare_restore_point(self, path: Path, catalog: StarCatalog) -> PreparedWorkspace:
        """Validate and freeze an account-local restore point before pruning."""
        candidate = Path(path).resolve()
        points_root = self.restore_points_dir.resolve()
        if candidate.parent != points_root or not candidate.is_dir() or not candidate.name.startswith("auto-"):
            raise ValueError("恢复快照不属于当前账号或已不存在")
        result = WorkspaceStore(candidate).load(catalog, backup_corrupt=False)
        if result.state is None:
            raise ValueError("该恢复快照无法读取，不能恢复")
        # ``prepare`` copies the structured data and captures image objects now,
        # before creating the safety point may prune this oldest directory.
        return self.prepare(result.state)

    def restore_prepared_workspace(
        self,
        prepared: PreparedWorkspace,
        catalog: StarCatalog,
    ) -> WorkspaceLoadResult:
        """Atomically replace the complete workspace with a prepared target.

        The ordinary autosave path replaces ``workspace.json`` atomically but
        updates image files in-place.  Restoration needs a stronger boundary:
        first build and validate a complete sibling directory, then swap that
        directory into place.  The current restore-point collection is copied
        into staging so the just-created manual safety point survives the
        replacement as well.
        """
        parent = self.root.parent
        stage = parent / f".{self.root.name}.restore-stage-{uuid4().hex}"
        backup = parent / f".{self.root.name}.restore-backup-{uuid4().hex}"
        moved_current = False
        with self._write_lock:
            try:
                parent.mkdir(parents=True, exist_ok=True)
                staged_store = WorkspaceStore(stage)
                staged_store.save(prepared)
                if self.restore_points_dir.exists():
                    shutil.copytree(self.restore_points_dir, staged_store.restore_points_dir)
                staged_result = staged_store.load(catalog, backup_corrupt=False)
                if staged_result.state is None:
                    raise RuntimeError(staged_result.warning or "恢复目标暂存校验失败")

                if self.root.exists():
                    self.root.replace(backup)
                    moved_current = True
                try:
                    stage.replace(self.root)
                except Exception:
                    if moved_current and backup.exists():
                        backup.replace(self.root)
                    raise
                if backup.exists():
                    try:
                        shutil.rmtree(backup)
                    except OSError:
                        # The new directory is already durable.  Retaining a
                        # locked old directory is safer than declaring a
                        # successful restore failed after the swap.
                        logger.warning("Could not remove old restore workspace %s", backup, exc_info=True)
                if prepared.revision is not None:
                    self._latest_revision = max(self._latest_revision, prepared.revision)
            except Exception:
                if stage.exists():
                    shutil.rmtree(stage, ignore_errors=True)
                raise
        result = self.load(catalog)
        if result.state is None:
            raise RuntimeError(result.warning or "恢复后的工作区无法重新加载")
        return result

    def _restore_point_info(self, path: Path, catalog: StarCatalog) -> RestorePointInfo:
        created_at, reason, metadata_warning = self._restore_point_metadata(path)
        try:
            payload = json.loads((path / "workspace.json").read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("工作区索引不是 JSON 对象")
            if payload.get("schema_version") != WORKSPACE_SCHEMA_VERSION:
                raise ValueError("工作区数据版本不受支持")
            snapshot = payload.get("state")
            if not isinstance(snapshot, dict):
                raise ValueError("工作区状态缺失")
            # Listing must be read-only and lightweight: validate only the
            # structured state, then inspect image paths without reading bytes
            # or invoking the ordinary migration/backup-aware ``load`` path.
            state = SessionState(catalog)
            state.restore(snapshot)
            missing_images: list[str] = []
            image_records = payload.get("images", [])
            if not isinstance(image_records, list):
                raise ValueError("工作区图片索引无效")
            image_count = 0
            root = path.resolve()
            for record in image_records:
                if not isinstance(record, dict) or not record.get("id"):
                    continue
                image_count += 1
                relative = Path(str(record.get("stored_path") or ""))
                source = path / relative
                try:
                    resolved_source = source.resolve()
                    exists = root in resolved_source.parents and source.is_file()
                except OSError:
                    exists = False
                if not exists:
                    missing_images.append(str(record.get("filename") or record["id"]))
            explicit_targets = {
                instance_id: level
                for instance_id, level in state.plan_targets.items()
                if any(row.star_instance_id == instance_id and level != row.level for row in state.rows)
            }
            warning = metadata_warning
            return RestorePointInfo(
                path=path,
                created_at=created_at,
                reason=reason,
                inventory_count=len(state.rows),
                image_count=image_count,
                explicit_plan_count=len(explicit_targets),
                has_ocr_result=bool(state.detected_items or state.image_audit),
                readable=True,
                missing_images=tuple(missing_images),
                warning=warning,
            )
        except Exception:
            # Corrupt points are an expected display state. Keep detailed
            # diagnostics in the local log without turning a normal card into
            # an application-level error.
            logger.info("Failed to inspect restore point %s", path, exc_info=True)
            return RestorePointInfo(
                path, created_at, reason, 0, 0, 0, False, False,
                warning="快照结构化数据无法读取。",
            )

    def _restore_point_metadata(self, path: Path) -> tuple[datetime, str, str | None]:
        fallback = self._legacy_restore_point_time(path)
        metadata_path = path / "restore-point.json"
        if not metadata_path.exists():
            return fallback, "pre_ocr", None
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("metadata is not an object")
            created_at = datetime.fromisoformat(str(payload["created_at"]).replace("Z", "+00:00"))
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            reason = str(payload.get("reason") or "pre_ocr")
            if reason not in {"pre_ocr", "pre_manual_restore"}:
                reason = "pre_ocr"
            return created_at, reason, None
        except Exception:
            logger.exception("Invalid restore point metadata at %s", metadata_path)
            return fallback, "pre_ocr", "快照元数据无法读取，已按旧格式展示。"

    @staticmethod
    def _legacy_restore_point_time(path: Path) -> datetime:
        try:
            payload = json.loads((path / "workspace.json").read_text(encoding="utf-8"))
            saved_at = payload.get("saved_at") if isinstance(payload, dict) else None
            if saved_at:
                value = datetime.fromisoformat(str(saved_at).replace("Z", "+00:00"))
                return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        except Exception:
            pass
        try:
            token = path.name.split("-")[1]
            return datetime.strptime(token, "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc)
        except Exception:
            return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)

    def _backup_corrupt_state(self) -> Path:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = self.root / f"workspace.corrupt-{stamp}.json"
        shutil.copy2(self.state_path, backup)
        return backup

    def _backup_pre_plan_migration(self) -> Path:
        existing = sorted(self.root.glob("workspace.pre-plan-targets-*.json"))
        if existing:
            return existing[-1]
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = self.root / f"workspace.pre-plan-targets-{stamp}.json"
        shutil.copy2(self.state_path, backup)
        return backup
