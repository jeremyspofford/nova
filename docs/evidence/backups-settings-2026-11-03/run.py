#!/usr/bin/env python3
"""Cache-only Task1 runner. No host HOME/Git/socket or mutable source mounts."""
import datetime, hashlib, json, os, pathlib, shlex, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[3]
evidence = pathlib.Path(__file__).resolve().parent
label, *command = sys.argv[1:]
run = evidence / label
run.mkdir(mode=0o700)
out = run / 'output'
out.mkdir(mode=0o700)
(out / 'egress.log').write_text('')
node = '/home/jeremy/.local/share/mise/installs/node/26.3.1'
deps = '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/node_modules'
argv = ['docker', 'run', '--rm', '--init', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', '--ipc=private', '--shm-size=1g', '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777', '--mount', f'type=bind,src={root},dst=/work,readonly', '--mount', f'type=bind,src={deps},dst=/work/node_modules,readonly', '--mount', f'type=bind,src={node},dst=/opt/node,readonly', '--mount', f'type=bind,src={out},dst=/evidence', '--workdir=/work', '--env=HOME=/tmp/backups-home', '--env=TMPDIR=/tmp', '--env=PATH=/opt/node/bin:/usr/bin:/bin', '--env=CI=1', '--env=TZ=UTC', '--env=NOVA_VAULT_KEY=file', '--env=NODE_OPTIONS=--import=/work/tests/acceptance/egress-guard.ts', '--env=NOVA_EGRESS_LOG=/evidence/egress.log', '--env=NOVA_BACKUPS_STYLEGUIDE_SHOTS=/evidence/screenshots', 'mcr.microsoft.com/playwright:v1.56.1-noble', '/bin/bash', '--noprofile', '--norc', '-c', 'mkdir -m 700 "$HOME"; export CHROMIUM="$(find /ms-playwright -path "*/chrome-linux/chrome" -print -quit)"; exec sh scripts/tripwire.sh "$@"', 'backups-task1', *command]
tracked = ['ui/js/view.js', 'ui/js/styleguide.js', 'ui/styles/views.css', 'ui/styles/styleguide.css', 'tests/backups-settings-view.test.js', 'tests/ui/backups-settings-styleguide.test.ts', 'package.json', 'package-lock.json']
meta = {'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host_cwd': str(root), 'container_cwd': '/work', 'argv': argv, 'shell_display': shlex.join(argv), 'image': 'sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a', 'inherited_image_environment': ['LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright'], 'runner_sha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(), 'source_hashes': {p: hashlib.sha256((root/p).read_bytes()).hexdigest() for p in tracked if (root/p).exists()}}
(run/'command.json').write_text(json.dumps(meta, indent=2)+'\n')
with (run/'stdout.txt').open('w') as log:
    proc = subprocess.Popen(argv, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in proc.stdout:
        log.write(line); log.flush(); print(line, end='', flush=True)
    code = proc.wait()
meta.update(finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), exit_code=code, egress_log_bytes=(out/'egress.log').stat().st_size)
(run/'command.json').write_text(json.dumps(meta, indent=2)+'\n')
sys.exit(code)
