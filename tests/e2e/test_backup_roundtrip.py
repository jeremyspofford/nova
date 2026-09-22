"""The single-host round trip: write a real bundle, then drill it.

`design-verdict.md` §12.4. This is the case that runs on ONE machine with a
live stack — back up, `restore --drill` the result, and require that every
table count, every digest, every volume listing and the signing-key
fingerprint compare equal, and that **no `nova-drill-*` object survives**.

**This is not requirement #28 and it must not be recorded as #28.** The move
rehearsal is *"back up on the Dell, `restore --drill` on the mini PC"* — two
machines — and a single-host case exercises none of what the cross-machine
walk is for: carrying the file and reading it back as the operator, a
different docker and compose version, a different postgres minor, a different
subnet, and a target with no v4 checkout history. That walk is §13 T7, run by
hand and recorded in `deploy/README.md`.

Running it, on a machine whose Nova is up::

    NOVA_E2E_LIVE=1 pytest tests/e2e/test_backup_roundtrip.py -v -s

Without `NOVA_E2E_LIVE` every case SKIPS and says so: it stops the live
stack's writers for the length of a backup and it creates and destroys docker
objects, so it never runs by accident.

`pytest.mark.live` is not registered in any pytest config in this repo yet, so
pytest warns about the mark. The SKIP is driven by the environment variable
and works regardless; registering the mark is one line, wherever the repo's
pytest config eventually lands.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy"

pytestmark = pytest.mark.live


def _live() -> bool:
    return os.environ.get("NOVA_E2E_LIVE") == "1"


requires_live = pytest.mark.skipif(
    not _live(),
    reason=(
        "live: this stops the running stack's writers and creates docker objects. "
        "Run it deliberately with NOVA_E2E_LIVE=1."
    ),
)


def run_verb(*argv: str, timeout: int = 3600) -> subprocess.CompletedProcess[str]:
    """One of `deploy/backup.sh`'s verbs, through the documented entry point.

    `./install backup|restore|drill` is the command the slice's definition of
    done, `deploy/README.md` and the move runbook are all written in terms of,
    so it is the command this measures. `install.sh` sources `backup.sh` only
    when one of those verbs is asked for, and exits with the verb's own code.
    """
    return subprocess.run(
        [str(REPO / "install"), *argv],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=timeout,
    )


def docker_names(kind: str) -> list[str]:
    """Every `nova-drill-*` object of one kind docker currently reports.

    `--filter name=` is an unanchored SUBSTRING match, which is wider than
    the `DRILL_RE` the verb asserts — wider is what this wants, because the
    question here is "did ANYTHING that looks like a drill survive".
    """
    if kind == "container":
        cmd = ["docker", "ps", "-a", "--filter", "name=nova-drill-", "--format", "{{.Names}}"]
    elif kind == "volume":
        cmd = ["docker", "volume", "ls", "--filter", "name=nova-drill-", "--format", "{{.Name}}"]
    elif kind == "network":
        cmd = ["docker", "network", "ls", "--filter", "name=nova-drill-", "--format", "{{.Name}}"]
    else:  # pragma: no cover - a typo in a test argument, not a product path
        raise AssertionError(kind)
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return [line for line in out.stdout.splitlines() if line.strip()]


def survivors() -> dict[str, list[str]]:
    return {kind: docker_names(kind) for kind in ("container", "volume", "network")}


@pytest.fixture(scope="module")
def archive_dir():
    path = tempfile.mkdtemp(prefix="nova-e2e-backup-")
    os.chmod(path, 0o700)
    yield Path(path)
    shutil.rmtree(path, ignore_errors=False)


@pytest.fixture(scope="module")
def bundle(archive_dir):
    """One real bundle off the live stack, written as the invoking operator."""
    before = survivors()
    assert before["volume"] == [], (
        f"a drill object is already here before anything ran: {before}. "
        "Clear it (./install drill sweeps) before measuring this."
    )
    done = run_verb("backup", "--out", str(archive_dir))
    assert done.returncode == 0, f"backup failed ({done.returncode}):\n{done.stderr}"
    tars = sorted(archive_dir.glob("nova-backup-*.tar"))
    assert len(tars) == 1, f"expected one bundle in {archive_dir}, found {tars}"
    return tars[0]


@requires_live
def test_the_operator_can_read_the_bundle_he_just_wrote(bundle):
    """python-tool C3, and a measured incident: a container writes the archive
    as root at mode 0600 and the operator's own `sha256sum` then fails with
    "Permission denied". Ownership was relaxed; the mode was not."""
    stat = bundle.stat()
    assert stat.st_mode & 0o777 == 0o600, oct(stat.st_mode & 0o777)
    assert stat.st_uid == os.getuid()
    digest = subprocess.run(["sha256sum", str(bundle)], capture_output=True, text=True, check=True)
    assert len(digest.stdout.split()[0]) == 64


@requires_live
def test_backup_then_drill_round_trips(bundle):
    """§9.3: every count, every digest, every volume listing and the signing
    key, compared against the numbers sealed in the bundle."""
    done = run_verb("restore", str(bundle), "--drill")
    assert done.returncode == 0, f"the drill failed:\n{done.stdout}\n{done.stderr}"

    # The three facts the word `drill` is only printed with (§9.2 step 16).
    assert "tables compared across" in done.stdout
    assert "volume listings diffed" in done.stdout
    assert "signing key" in done.stdout

    # Every volume the bundle carries was untarred and its listing re-derived
    # and diffed (port-v3 M5): a drill that only restores the dumps proves
    # nothing about v4_memdata, the notes, which exist nowhere else.
    listed = [line for line in done.stdout.splitlines() if line.startswith("volume ")]
    assert listed, f"no volume was restored by the drill:\n{done.stdout}"
    for line in listed:
        assert "listing identical" in line, line


@requires_live
def test_no_drill_object_survives(bundle):
    """§9.3 step 5: the teardown removes every object the run created and
    VERIFIES each removal. A `finally` does not survive a process restart,
    which is why `drill` also has a sweep — but a drill that exits 0 has no
    excuse for a leftover."""
    left = survivors()
    assert left == {"container": [], "volume": [], "network": []}, left


@requires_live
def test_the_drill_verb_answers_the_question(archive_dir, bundle):
    """§9.4: `./install drill` sweeps, picks the newest bundle by the stamp in
    its own name, runs the drill and cross-checks every older bundle's
    passphrase fingerprint. THE EXIT CODE IS THE VERDICT."""
    done = run_verb("drill", "--out", str(archive_dir))
    assert done.returncode == 0, f"the drill verb failed:\n{done.stdout}\n{done.stderr}"
    assert f"drill PASSED: {bundle.name}" in done.stdout
    assert survivors() == {"container": [], "volume": [], "network": []}


@requires_live
def test_coverage_refuses_an_undeclared_volume_against_a_live_daemon(tmp_path):
    """The refusal is real and not only a fixture behaviour (§12.4).

    A COPY of the compose file gains a volume with no `x-nova-backup` row.
    Nothing touches the checked-in file and nothing is started from the copy:
    `docker compose config` renders it, coverage classifies it, and the run
    must refuse before a single writer is stopped.
    """
    copy = tmp_path / "docker-compose.yml"
    text = (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")
    assert "\nvolumes:\n" in text, "the compose file has no top-level volumes block"
    text = text.replace("\nvolumes:\n", "\nvolumes:\n  e2e_undeclared_probe:\n", 1)
    copy.write_text(text, encoding="utf-8")

    out = tmp_path / "archive"
    done = subprocess.run(
        [str(REPO / "install"), "backup", "--out", str(out)],
        capture_output=True,
        text=True,
        cwd=REPO,
        env=dict(os.environ, BK_COMPOSE_FILES=str(copy)),
        timeout=900,
    )
    assert done.returncode != 0, f"an unclassified volume did not refuse:\n{done.stdout}"
    assert "e2e_undeclared_probe" in done.stderr, done.stderr
    assert not list(out.glob("*.tar")), "a bundle was written despite the refusal"


@requires_live
def test_the_bundle_says_what_it_carried(bundle, tmp_path):
    """The manifest sealed inside is what every restore decision reads, so the
    round trip is only meaningful if it is there and is the shape §5.3
    documents. Read through the reader that SHIPS in the bundle, with no
    passphrase on the command line."""
    reader = tmp_path / "nova_restore.py"
    reader.write_bytes(
        subprocess.run(
            ["tar", "-xOf", str(bundle), "nova_restore.py"],
            capture_output=True,
            check=True,
        ).stdout
    )
    meta = json.loads(
        subprocess.run(
            ["tar", "-xOf", str(bundle), "meta.json"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    )
    assert meta["format"] == "nova-backup/2"
    assert meta["bundle_version"] == 2
    assert meta["encrypted"] is True
    # The digest published out of band covers every bundle for a commit.
    committed = subprocess.run(
        ["sha256sum", str(DEPLOY / "backup" / "nova_restore.py")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()[0]
    shipped = subprocess.run(
        ["sha256sum", str(reader)], capture_output=True, text=True, check=True
    ).stdout.split()[0]
    assert shipped == committed, "the reader in the bundle is not the one in git"
