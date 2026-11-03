import datetime
import hashlib
import shutil
import json
import os
import pathlib
import subprocess
import sys
import tempfile

repo = pathlib.Path('/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build')
evidence = repo / '.superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-7'
label = sys.argv[1]
command = sys.argv[2:]
private_home = tempfile.mkdtemp(prefix='nova-task7-docker-home-')
env = {'PATH': '/usr/bin:/bin', 'HOME': private_home, 'LANG': 'C.UTF-8'}
# Self.build needs only the current HEAD identity. Reconstruct this own commit object into a
# private Git dir; never mount the shared common dir, config, hooks or any owner home.
git_env = {**env, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
def own_git(*args):
    return subprocess.check_output(['git', *args], cwd=repo, env=git_env)
head = own_git('rev-parse', 'HEAD').decode().strip()
commit = own_git('cat-file', 'commit', head)
assert hashlib.sha1(b'commit ' + str(len(commit)).encode() + b'\0' + commit).hexdigest() == head
gitdir = pathlib.Path(private_home) / 'git-identity'
for part in ['objects', 'refs/heads', 'refs/tags']:
    (gitdir / part).mkdir(parents=True, exist_ok=True)
(gitdir / 'HEAD').write_text(head + '\n')
(gitdir / 'config').write_text('[core]\n repositoryformatversion = 0\n bare = false\n')
written = subprocess.check_output(['git', '--git-dir=' + str(gitdir), 'hash-object', '-w', '-t', 'commit', '--stdin'], input=commit, env=git_env).decode().strip()
visible = subprocess.check_output(['git', '--git-dir=' + str(gitdir), 'rev-parse', 'HEAD'], env=git_env).decode().strip()
assert written == visible == head
pointer = (repo / '.git').read_text().strip()
assert pointer.startswith('gitdir: /')
git_target = pointer.removeprefix('gitdir: ')
dirty = set(own_git('diff', '--name-only', 'HEAD').decode().splitlines()) | set(own_git('ls-files', '--others', '--exclude-standard').decode().splitlines())
source_hashes = {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in own_git('ls-files', 'src', 'tests', 'scripts').decode().splitlines() if (repo / name).is_file()}
identity = {'source_tree_sha256': source_hashes, 'host_head': head, 'visible_commit': visible, 'validated_commit_object': written,
            'scope': 'HEAD commit object only; no shared config/refs/tree/history; dirty sources are not this commit',
            'changed_files_sha256': {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in sorted(dirty) if (repo / name).is_file()}}
argv = ['/usr/bin/docker', 'run', '--rm', '--pull=never', '--network=none', '--user=1000:1000', '--read-only',
        '--tmpfs', '/tmp:rw,exec,nosuid,size=1g', '--mount', f'type=bind,src={gitdir},dst={git_target},readonly', '--mount', f'type=bind,src={repo},dst=/workspace,readonly',
        '--mount', 'type=bind,src=/home/jeremy/.local/share/mise/installs/node/26.3.1,dst=/opt/node,readonly',
        '--workdir', '/workspace', '--env', 'HOME=/tmp/nova-task7-private-home', '--env', 'PATH=/opt/node/bin:/usr/bin:/bin',
        '--env', 'TZ=UTC', '--env', 'LANG=C.UTF-8', '--env', 'NOVA_VAULT_KEY=file', '--env', 'npm_config_update_notifier=false', 'mcr.microsoft.com/playwright:v1.56.1-noble',
        'sh', '-c', 'mkdir -m 700 "$HOME"; "$@"; result=$?; if [ -s /tmp/task7-egress.log ]; then cat /tmp/task7-egress.log >&2; exit 97; fi; echo "Task7 egress guard: never fired"; exit "$result"', 'task7', *command]
record = {'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'cwd': str(repo),
          'launcher_env': env, 'argv': argv, 'command': command, 'git_identity': identity}
meta = evidence / f'{label}.json'
if meta.exists():
    raise SystemExit(f'Refusing to overwrite evidence: {meta}')
meta.write_text(json.dumps(record, indent=2) + '\n')
with (evidence / f'{label}.stdout').open('w') as out, (evidence / f'{label}.stderr').open('w') as err:
    result = subprocess.run(argv, cwd=repo, env=env, stdout=out, stderr=err)
record.update(exit_code=result.returncode, ended_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
meta.write_text(json.dumps(record, indent=2) + '\n')
shutil.rmtree(private_home)
print(json.dumps({"label": label, "exit_code": result.returncode, "record": str(meta)}))
print((evidence / f'{label}.stdout').read_text())
print((evidence / f'{label}.stderr').read_text())
sys.exit(result.returncode)
