from pathlib import Path
import hashlib,json,shutil,subprocess
repo=Path('/home/jeremy/.codex/worktrees/nova-health-backend-wiring/nova-build')
evidence=repo/'.superpowers/sdd/health-backend-wiring-2026-11-03/evidence/task-1'
original=Path('/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/.superpowers/sdd/health-caps-diagnostics-2026-11-03')
paths=[original/name for name in ['task-2-report.md','task-2-review.md','task-2-invocation-history.md','task-3-report.md','task-3-review.md']]
for name in ['task-2','task-3']:
 paths.extend(p for p in sorted((original/'evidence'/name).rglob('*')) if p.is_file())
archive=evidence/'original-health'
archive.mkdir(exist_ok=False)
manifest=[]
for source in paths:
 target=archive/source.relative_to(original)
 target.parent.mkdir(parents=True,exist_ok=True)
 shutil.copyfile(source,target)
 before=hashlib.sha256(source.read_bytes()).hexdigest()
 after=hashlib.sha256(target.read_bytes()).hexdigest()
 assert before==after
 manifest.append({'source':str(source),'copy':str(target.relative_to(evidence)),'sha256':after,'bytes':target.stat().st_size})
(evidence/'original-health-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
reviewed='1572f294d319791bfaa73ccf224335eb06eb1bbc'
base='0134b074b3c97ed67c4d5765a1ba788be1205145'
changed=subprocess.check_output(['git','diff','--name-only',base,'HEAD'],cwd=repo,text=True).splitlines()
rows=[]
for file in changed:
 local=subprocess.check_output(['git','rev-parse',f'HEAD:{file}'],cwd=repo,text=True).strip()
 source=subprocess.check_output(['git','rev-parse',f'{reviewed}:{file}'],cwd=repo,text=True).strip()
 actual=subprocess.check_output(['git','hash-object',file],cwd=repo,text=True).strip()
 assert local==source==actual
 rows.append({'path':file,'reviewed_blob':source,'integration_blob':local,'worktree_blob':actual,'equal':True})
(evidence/'source-blobs.json').write_text(json.dumps({'base':base,'reviewed':reviewed,'tested_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'files':rows},indent=2)+'\n')
protected=['ui','package.json','package-lock.json','docs/plans/health-backend-wiring-2026-11-03.md','docs/builder-packet/CAPABILITY-INVENTORY.md','docs/builder-packet/WORK-LEDGER-AND-VERIFICATION.md','src/core/child-env.ts','src/core/ledger.ts','src/core/diagnostics/index.ts','src/core/models/index.ts','tests/core/caps.test.ts','tests/core/diagnostics.test.ts','tests/acceptance/egress-guard.ts','scripts/tripwire.sh']
result=subprocess.run(['git','diff','--exit-code',base,'--',*protected],cwd=repo,capture_output=True,text=True)
assert result.returncode==0,(result.stdout,result.stderr)
(evidence/'protected-scope.json').write_text(json.dumps({'command':['git','diff','--exit-code',base,'--',*protected],'exit_code':result.returncode,'stdout':result.stdout,'stderr':result.stderr},indent=2)+'\n')
print(json.dumps({'archived_original_files':len(manifest),'archived_bytes':sum(p['bytes'] for p in manifest),'source_blob_matches':len(rows),'runtime_test_blob_matches':sum(p['path'].startswith(('src/','tests/')) and p['path']!='src/core/README.md' for p in rows),'protected_scope_exit':result.returncode},indent=2))
