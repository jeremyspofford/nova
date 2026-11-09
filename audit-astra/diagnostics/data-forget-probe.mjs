// Audit-only synthetic diagnostic. No model/network calls or product modifications.
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { Memory } from '../../src/memory.js';
import { restoreInto } from '../../src/core/resilience/backup.ts';

const dir = mkdtempSync(join(tmpdir(), 'nova-astra-data-probe-'));
const home = join(dir, 'home');
const target = join(dir, 'backups');
mkdirSync(target, {mode:0o700});
const c = createCore({ home, version:'audit', trustedOrigin:()=>true, vault:{mode:'file',keychain:null} });
const m = new Memory(home, 'UTC', {records:c.memory});
c.memory.onForget(records => m.forgotten(records));
const now = new Date('2026-11-09T21:05:00Z');
try {
  const a = m.remember({kind:'fact',text:'The synthetic redwood cabin has code 7284.',from:'audit-turn-1'},now);
  m.note({text:'The synthetic redwood cabin has code 7284.',from:'audit-turn-1'},now);
  const b = m.remember({kind:'fact',text:'The fictional apartment uses a brass key.',replaces:a.id,from:'audit-turn-2'},now);
  const before = m.search('redwood cabin 7284');
  const removed = m.forget(b.id);
  const after = m.search('redwood cabin 7284');
  console.log(JSON.stringify({scenario:'corrected-memory-forget',before,removed:removed.map(x=>x.text),after,coreRecords:c.memory.list()},null,2));

  const note = m.note({text:'AUDIT_CANARY_DAYNOTE synthetic orchard access phrase.',from:'audit-turn-3'},now);
  c.resilience.setSettings({target});
  const bk = c.resilience.nightly.run();
  const noteRemoved = m.forget(note.id);
  const restoredHome = join(dir,'restored');
  restoreInto(bk.path,restoredHome);
  const notePath = join('memory','2026-11-09.md');
  console.log(JSON.stringify({scenario:'day-note-forget-backup',noteId:note.id,removed:noteRemoved.map(x=>x.text),liveHasCanary:readFileSync(join(home,notePath),'utf8').includes('AUDIT_CANARY_DAYNOTE'),backupHasCanary:readFileSync(join(bk.path,'files',notePath),'utf8').includes('AUDIT_CANARY_DAYNOTE'),restoredHasCanary:readFileSync(join(restoredHome,notePath),'utf8').includes('AUDIT_CANARY_DAYNOTE')},null,2));

  const e = c.memory.remember({kind:'fact',content:'AUDIT_CANARY_EXPORT synthetic blue summit.',recorded_by:'person'});
  const exported = c.memory.export();
  c.memory.forget(e.id);
  console.log(JSON.stringify({scenario:'export-after-forget',jsonHasCanary:readFileSync(exported.json,'utf8').includes('AUDIT_CANARY_EXPORT'),markdownHasCanary:readFileSync(exported.markdown,'utf8').includes('AUDIT_CANARY_EXPORT'),exportFolderUnderHome:exported.dir.startsWith(home)},null,2));
  console.log(JSON.stringify({syntheticFixture:dir},null,2));
} finally { await c.close(); }
