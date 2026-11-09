// Audit-only synthetic fixture; no actual capture, model, or outside service.
import { mkdtempSync, mkdirSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCore } from '../../src/core/index.ts';

const dir=mkdtempSync(join(tmpdir(),'nova-astra-capture-probe-'));
const home=join(dir,'home'), target=join(dir,'backups'), detached=join(dir,'unmounted-backups');
mkdirSync(target,{mode:0o700});
const c=createCore({home,version:'audit',trustedOrigin:()=>true,vault:{mode:'file',keychain:null}});
try {
 const s=c.capture.addScreenpipe({url:'http://127.0.0.1:3030'});
 c.capture.enable(s.id,{by:'console',since:'2026-01-01T00:00:00.000Z'});
 const r=c.capture.ingest(s.id,[{kind:'screen',at:new Date().toISOString(),text:'AUDIT_CANARY_CAPTURE synthetic alpine text.',app:'Editor',external_id:'audit-1'}],'api');
 if(r.kept.length!==1) throw new Error(JSON.stringify(r));
 c.resilience.setSettings({target});
 const b=c.resilience.nightly.run();
 renameSync(target,detached); // This fixture alone simulates an unavailable removable disk.
 const deleted=c.capture.forget(r.kept,'console');
 const owed=c.resilience.nightly.owedView();
 const dbPath=join(detached,b.path.split('/').at(-1),'nova.db');
 const db=new DatabaseSync(dbPath,{readOnly:true});
 const saved=db.prepare('SELECT text FROM capture_event WHERE id = ?').get(r.kept[0]);
 db.close();
 console.log(JSON.stringify({scenario:'capture-forget-with-unavailable-backup',deleted,owed:owed.map(x=>({kind:x.kind,forgets:x.forgets})),backupStillHasEvent:!!saved,backupStillHasCanary:readFileSync(dbPath).includes('AUDIT_CANARY_CAPTURE')},null,2));
 renameSync(detached,target);
 const applied=c.resilience.nightly.applyOwed();
 const restored=new DatabaseSync(b.path+'/nova.db',{readOnly:true});
 const left=restored.prepare('SELECT COUNT(*) n FROM capture_event WHERE id=?').get(r.kept[0]).n;
 restored.close();
 console.log(JSON.stringify({scenario:'backup-returned-and-owed-forget-applied',applied:applied.applied.length,eventsLeft:left},null,2));
} finally {await c.close();}
