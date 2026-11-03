import datetime,hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[4]
label=sys.argv[1]; command=sys.argv[2:]
out=root/'docs/evidence/backups-settings-2026-11-03/task-2'/label
out.mkdir(parents=True,exist_ok=False)
(out/'output').mkdir()
(out/'output/egress.log').touch()
argv=['docker','run','--rm','--init','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','--ipc=private','--shm-size=1g','--tmpfs=/tmp:rw,nosuid,nodev,mode=1777','--mount',f'type=bind,src={root},dst=/work,readonly','--mount','type=bind,src=/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/node_modules,dst=/work/node_modules,readonly','--mount','type=bind,src=/home/jeremy/.local/share/mise/installs/node/26.3.1,dst=/opt/node,readonly','--mount',f'type=bind,src={out}/output,dst=/evidence','--workdir=/work','--env=HOME=/tmp/backups-home','--env=TMPDIR=/tmp','--env=PATH=/opt/node/bin:/usr/bin:/bin','--env=CI=1','--env=TZ=UTC','--env=NOVA_VAULT_KEY=file','--env=NODE_OPTIONS=--import=/work/tests/acceptance/egress-guard.ts','--env=NOVA_EGRESS_LOG=/evidence/egress.log','--env=NOVA_BACKUPS_APP_SHOTS=/evidence/screenshots','--env=NOVA_NAV_EVIDENCE=/evidence/navigation','mcr.microsoft.com/playwright:v1.56.1-noble','/bin/bash','--noprofile','--norc','-c','mkdir -m 700 "$HOME"; export CHROMIUM="$(find /ms-playwright -path "*/chrome-linux/chrome" -print -quit)"; exec sh scripts/tripwire.sh "$@"','backups-task2',*command]
files=['ui/js/app.js','ui/js/view.js','ui/js/surfaces.js','ui/js/backups.js','ui/js/settings-ia.js','tests/ui/backups-settings.test.ts','tests/ui/navigation-reachability.test.ts','package.json','package-lock.json','scripts/tripwire.sh','tests/acceptance/egress-guard.ts']
meta={'start_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cwd':str(root),'argv':argv,'source_sha256':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files if (root/f).exists()}}
(out/'command.json').write_text(json.dumps(meta,indent=2)+'\n')
with (out/'stdout.txt').open('w') as stdout,(out/'stderr.txt').open('w') as stderr:
 r=subprocess.run(argv,cwd=root,stdout=stdout,stderr=stderr)
meta.update(end_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),exit_code=r.returncode,egress_bytes=(out/'output/egress.log').stat().st_size)
(out/'command.json').write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps({'label':label,'exit_code':r.returncode}))
print((out/'stdout.txt').read_text()[-14000:]);print((out/'stderr.txt').read_text()[-4000:])
sys.exit(r.returncode)
