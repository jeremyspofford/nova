"""Backup and restore operations via pg_dump / pg_restore."""

import asyncio
import logging
import os
import shutil
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .config import settings

logger = logging.getLogger("nova.recovery.backup")

# OKF markdown memory bundle. Mounted rw from the host workspace so backup can
# capture it and restore can write back into it — memory lives in files, not
# Postgres, so pg_dump alone would miss it. If the dir is missing (e.g., early
# install), backup skips it silently.
MEMORY_DIR = Path("/workspace/memory")


def _backup_dir() -> Path:
    d = settings.backup_dir
    d.mkdir(parents=True, exist_ok=True)
    return d


def _memory_files() -> list[Path]:
    """List all files under MEMORY_DIR that a backup should include."""
    if not MEMORY_DIR.exists() or not MEMORY_DIR.is_dir():
        return []
    return [f for f in MEMORY_DIR.rglob("*") if f.is_file()]


def _add_memory_to_archive(tar: tarfile.TarFile) -> int:
    """Add the OKF memory bundle to an open tar archive.
    Returns count of files added."""
    files = _memory_files()
    for f in files:
        # Store with relative path under "memory/" prefix inside the archive
        tar.add(f, arcname=f"memory/{f.relative_to(MEMORY_DIR).as_posix()}")
    if files:
        logger.info("Included %d memory file(s) in backup", len(files))
    return len(files)


def _restore_memory_from_archive(archive_dir: Path) -> int:
    """If the extracted archive contains a memory/ subdir, replace the live
    MEMORY_DIR contents with it. Returns count of files restored."""
    staged = archive_dir / "memory"
    if not staged.exists() or not staged.is_dir():
        return 0
    if not MEMORY_DIR.exists():
        MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    # Wipe existing to mirror the DB's DROP-and-recreate semantics — the backup
    # is the authoritative state, anything added post-backup is intentionally lost.
    for child in MEMORY_DIR.iterdir():
        if child.is_file() or child.is_symlink():
            child.unlink()
        elif child.is_dir():
            shutil.rmtree(child)
    count = 0
    for f in staged.rglob("*"):
        if f.is_file():
            dest = MEMORY_DIR / f.relative_to(staged)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)
            count += 1
    logger.info("Restored %d memory file(s)", count)
    return count


def list_backups() -> list[dict]:
    """List available backups sorted newest-first."""
    d = _backup_dir()
    backups = []
    for f in sorted(d.glob("nova-backup-*.tar.gz"), reverse=True):
        stat = f.stat()
        backups.append({
            "filename": f.name,
            "size_bytes": stat.st_size,
            "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })
    return backups


async def create_backup() -> dict:
    """Create a backup: pg_dump + config files → single .tar.gz."""
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"nova-backup-{timestamp}.tar.gz"
    outpath = _backup_dir() / filename

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        # pg_dump
        sql_path = tmp / "database.sql"
        proc = await asyncio.create_subprocess_exec(
            "pg_dump",
            "-h", settings.pg_host,
            "-p", str(settings.pg_port),
            "-U", settings.pg_user,
            "-d", settings.pg_database,
            "--no-owner",
            "--no-acl",
            "--clean",
            "--if-exists",
            "-f", str(sql_path),
            env={**os.environ, "PGPASSWORD": settings.pg_password},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"pg_dump failed: {stderr.decode()}")

        # Bundle into tar.gz
        with tarfile.open(outpath, "w:gz") as tar:
            tar.add(sql_path, arcname="database.sql")
            _add_memory_to_archive(tar)

        logger.info("Backup created: %s (%.1f MB)", filename, outpath.stat().st_size / 1_048_576)

    # Prune old backups
    _prune_old_backups()

    stat = outpath.stat()
    return {
        "filename": filename,
        "size_bytes": stat.st_size,
        "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }


async def restore_backup(filename: str) -> dict:
    """Restore database from a backup .tar.gz file."""
    backup_path = _backup_dir() / filename
    if not backup_path.exists():
        raise FileNotFoundError(f"Backup not found: {filename}")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        # Extract
        with tarfile.open(backup_path, "r:gz") as tar:
            tar.extractall(tmp, filter="data")

        sql_path = tmp / "database.sql"
        if not sql_path.exists():
            raise RuntimeError("Backup archive missing database.sql")

        # Strip pg17-specific directives that break restore on pg16:
        # - \restrict / \unrestrict block \. data terminators in COPY blocks
        # - SET transaction_timeout is unrecognized by pg16
        strip_proc = await asyncio.create_subprocess_exec(
            "sed", "-i",
            r"/^\\restrict/d;/^\\unrestrict/d;/^SET transaction_timeout/d",
            str(sql_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await strip_proc.communicate()

        # Drop all existing tables so the restore can recreate them cleanly
        drop_proc = await asyncio.create_subprocess_exec(
            "psql",
            "-h", settings.pg_host,
            "-p", str(settings.pg_port),
            "-U", settings.pg_user,
            "-d", settings.pg_database,
            "-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            env={**os.environ, "PGPASSWORD": settings.pg_password},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, drop_stderr = await drop_proc.communicate()
        if drop_proc.returncode != 0:
            raise RuntimeError(f"Schema reset failed: {drop_stderr.decode()}")

        # Restore from dump
        proc = await asyncio.create_subprocess_exec(
            "psql",
            "-h", settings.pg_host,
            "-p", str(settings.pg_port),
            "-U", settings.pg_user,
            "-d", settings.pg_database,
            "-f", str(sql_path),
            "--single-transaction",
            env={**os.environ, "PGPASSWORD": settings.pg_password},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"Database restore failed: {stderr.decode()}")

        # Restore filesystem source blobs (after DB so source_ref_id rows resolve)
        memory_restored = _restore_memory_from_archive(tmp)

    logger.info("Restored from backup: %s", filename)
    return {"filename": filename, "restored": True, "memory_files_restored": memory_restored}


def delete_backup(filename: str) -> dict:
    """Delete a specific backup file."""
    backup_path = _backup_dir() / filename
    if not backup_path.exists():
        raise FileNotFoundError(f"Backup not found: {filename}")
    # Safety: only delete files matching our naming pattern
    if not filename.startswith("nova-backup-") or not filename.endswith(".tar.gz"):
        raise ValueError("Invalid backup filename")
    backup_path.unlink()
    logger.info("Deleted backup: %s", filename)
    return {"filename": filename, "deleted": True}


def list_checkpoints() -> list[dict]:
    """List automatic checkpoint backups sorted newest-first."""
    d = _backup_dir()
    checkpoints = []
    for f in sorted(d.glob("nova-checkpoint-*.tar.gz"), reverse=True):
        stat = f.stat()
        checkpoints.append({
            "filename": f.name,
            "size_bytes": stat.st_size,
            "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })
    return checkpoints


async def create_checkpoint() -> dict:
    """Create an automatic checkpoint backup (same as manual but different prefix)."""
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"nova-checkpoint-{timestamp}.tar.gz"
    outpath = _backup_dir() / filename

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        sql_path = tmp / "database.sql"
        proc = await asyncio.create_subprocess_exec(
            "pg_dump",
            "-h", settings.pg_host,
            "-p", str(settings.pg_port),
            "-U", settings.pg_user,
            "-d", settings.pg_database,
            "--no-owner",
            "--no-acl",
            "--clean",
            "--if-exists",
            "-f", str(sql_path),
            env={**os.environ, "PGPASSWORD": settings.pg_password},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"pg_dump failed: {stderr.decode()}")

        with tarfile.open(outpath, "w:gz") as tar:
            tar.add(sql_path, arcname="database.sql")
            _add_memory_to_archive(tar)

        logger.info("Checkpoint created: %s (%.1f MB)", filename, outpath.stat().st_size / 1_048_576)

    stat = outpath.stat()
    return {
        "filename": filename,
        "size_bytes": stat.st_size,
        "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }


def prune_checkpoints(max_keep: int) -> int:
    """Delete oldest checkpoints beyond the retention limit. Returns number pruned."""
    d = _backup_dir()
    checkpoints = sorted(d.glob("nova-checkpoint-*.tar.gz"), key=lambda f: f.stat().st_mtime, reverse=True)
    pruned = 0
    for f in checkpoints[max_keep:]:
        f.unlink()
        logger.info("Pruned checkpoint: %s", f.name)
        pruned += 1
    return pruned


def _prune_old_backups():
    """Remove backups older than retention period."""
    if settings.backup_retain_days <= 0:
        return
    d = _backup_dir()
    cutoff = datetime.now(tz=timezone.utc).timestamp() - (settings.backup_retain_days * 86400)
    for f in d.glob("nova-backup-*.tar.gz"):
        if f.stat().st_mtime < cutoff:
            f.unlink()
            logger.info("Pruned old backup: %s", f.name)
