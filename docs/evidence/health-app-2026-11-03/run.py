#!/usr/bin/env python3
"""Cache-only Health Task4 runner. No host HOME/Git/socket or mutable source mounts."""
import datetime, hashlib, json, os, pathlib, shlex, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[3]
evidence = pathlib.Path(__file__).resolve().parent
label, *command = sys.argv[1:]
run = evidence / label
run.mkdir(mode=0o700)
out = run / 'output'
out.mkdir(mode=0o700)
(out / 'egress.log').write_text('')
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
(out / 'source-commit.txt').write_bytes(subprocess.check_output(['git', 'cat-file', 'commit', head], cwd=root))
(out / 'git-pointer').write_text('gitdir: /tmp/health-git\n')
node = '/home/jeremy/.local/share/mise/installs/node/26.3.1'
deps = '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/node_modules'
argv = ['docker', 'run', '--cidfile', str(run/'container.id'), '--rm', '--init', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', '--ipc=private', '--shm-size=1g', '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777', '--mount', f'type=bind,src={root},dst=/work,readonly', '--mount', f'type=bind,src={deps},dst=/work/node_modules,readonly', '--mount', f'type=bind,src={node},dst=/opt/node,readonly', '--mount', f'type=bind,src={out},dst=/evidence', '--mount', f'type=bind,src={out}/git-pointer,dst=/work/.git,readonly', '--workdir=/work', '--env=HOME=/tmp/health-home', '--env=TMPDIR=/tmp', '--env=PATH=/opt/node/bin:/usr/bin:/bin', '--env=CI=1', '--env=TZ=UTC', '--env=NOVA_VAULT_KEY=file', '--env=NODE_OPTIONS=--import=/work/tests/acceptance/egress-guard.ts', '--env=NOVA_EGRESS_LOG=/evidence/egress.log', '--env=NOVA_HEALTH_APP_SHOTS=/evidence/screenshots', 'mcr.microsoft.com/playwright:v1.56.1-noble', '/bin/bash', '--noprofile', '--norc', '-c', f'set -eu; mkdir -m 700 "$HOME"; git init --bare -q /tmp/health-git; git --git-dir=/tmp/health-git hash-object -t commit -w --stdin </evidence/source-commit.txt; git --git-dir=/tmp/health-git update-ref refs/heads/source {head}; git --git-dir=/tmp/health-git symbolic-ref HEAD refs/heads/source; export CHROMIUM="$(find /ms-playwright -path "*/chrome-linux/chrome" -print -quit)"; exec sh scripts/tripwire.sh "$@"', 'health-task4', *command]
tracked = ['.github/workflows/ci.yml', 'scripts/ci-changes.sh', 'tests/ci-changes.test.js', 'tests/ui/health-diagnostics-visual.ts', 'src/core/browser/png.ts', 'ui/styles/components.css', 'ui/styles/layout.css', 'tests/ui/support.ts', 'tests/ui/m10i-topology.test.ts', 'tests/ui/m10i-support.ts', 'tests/ui/health-topology-offline-baseline-probe.ts', 'ui/sw.js', 'tests/support/fixtures/health-sw-v14.js.txt', 'tests/health-components.test.js', 'tests/m9-wait.test.js', 'ui/js/surfaces.js', 'ui/js/app.js', 'ui/js/components.js', 'ui/js/wait.js', 'tests/ui/health-caps-diagnostics.test.ts', 'tests/ui/navigation-reachability.test.ts', 'package.json', 'package-lock.json', 'tests/ui/health-reload-probe.ts', 'docs/evidence/health-app-2026-11-03/debug-baseline/app.js', 'docs/evidence/health-app-2026-11-03/debug-baseline/components.js', 'docs/evidence/health-app-2026-11-03/debug-baseline/surfaces.js']
meta = {'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host_cwd': str(root), 'container_cwd': '/work', 'argv': argv, 'shell_display': shlex.join(argv), 'image': 'sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a', 'inherited_image_environment': ['LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright'], 'visible_commit': head, 'source_commit_sha256': hashlib.sha256((out/'source-commit.txt').read_bytes()).hexdigest(), 'runner_sha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(), 'source_hashes': {p: hashlib.sha256((root/p).read_bytes()).hexdigest() for p in tracked if (root/p).exists()}}
(run/'command.json').write_text(json.dumps(meta, indent=2)+'\n')
proc = None
try:
    with (run/'stdout.txt').open('w') as log:
        proc = subprocess.Popen(argv, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in proc.stdout:
            log.write(line); log.flush(); print(line, end='', flush=True)
        code = proc.wait()
finally:
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=10)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    if (run/'container.id').exists():
        cid = (run/'container.id').read_text().strip()
        inspection = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', cid], capture_output=True, text=True)
        meta['owned_container_cleanup'] = {'cid': cid, 'inspect_exit': inspection.returncode, 'running': inspection.stdout.strip()}
        if inspection.returncode == 0:
            removal = subprocess.run(['docker', 'rm', '-f', cid], capture_output=True, text=True)
            meta['owned_container_cleanup']['removal_exit'] = removal.returncode
        (run/'command.json').write_text(json.dumps(meta, indent=2)+'\n')
meta.update(finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), exit_code=code, egress_log_bytes=(out/'egress.log').stat().st_size)
(run/'command.json').write_text(json.dumps(meta, indent=2)+'\n')
sys.exit(code)
