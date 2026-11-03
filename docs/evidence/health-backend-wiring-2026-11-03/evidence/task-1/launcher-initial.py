import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile

repo = pathlib.Path('/home/jeremy/.codex/worktrees/nova-health-backend-wiring/nova-build')
evidence = repo / '.superpowers/sdd/health-backend-wiring-2026-11-03/evidence/task-1'
label = sys.argv[1]
command = sys.argv[2:]
private_home = tempfile.mkdtemp(prefix='nova-health-backend-task1-docker-home-')
env = {'PATH': '/usr/bin:/bin', 'HOME': private_home, 'LANG': 'C.UTF-8'}
argv = ['/usr/bin/docker', 'run', '--rm', '--pull=never', '--network=none', '--user=1000:1000', '--read-only',
        '--tmpfs', '/tmp:rw,exec,nosuid,size=1g', '--mount', f'type=bind,src={repo},dst=/workspace,readonly',
        '--mount', 'type=bind,src=/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/node_modules,dst=/workspace/node_modules,readonly',
        '--mount', 'type=bind,src=/home/jeremy/.local/share/mise/installs/node/26.3.1,dst=/opt/node,readonly',
        '--workdir', '/workspace', '--env', 'HOME=/tmp/nova-health-backend-task1-private-home', '--env', 'PATH=/opt/node/bin:/usr/bin:/bin',
        '--env', 'NOVA_VAULT_KEY=file', '--env', 'NPM_CONFIG_UPDATE_NOTIFIER=false',
        '--env', 'TZ=UTC', '--env', 'LANG=C.UTF-8', 'mcr.microsoft.com/playwright:v1.56.1-noble',
        'sh', '-c', 'mkdir -m 700 "$HOME" && exec "$@"', 'health-backend-task1', *command]
record = {'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'cwd': str(repo),
          'launcher_env': env, 'argv': argv, 'command': command}
meta = evidence / f'{label}.json'
if meta.exists():
    raise SystemExit(f'Refusing to overwrite evidence: {meta}')
meta.write_text(json.dumps(record, indent=2) + '\n')
with (evidence / f'{label}.stdout').open('w') as out, (evidence / f'{label}.stderr').open('w') as err:
    result = subprocess.run(argv, cwd=repo, env=env, stdout=out, stderr=err)
record.update(exit_code=result.returncode, ended_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
meta.write_text(json.dumps(record, indent=2) + '\n')
os.rmdir(private_home)
print(json.dumps(record, indent=2))
print((evidence / f'{label}.stdout').read_text())
print((evidence / f'{label}.stderr').read_text())
sys.exit(result.returncode)
