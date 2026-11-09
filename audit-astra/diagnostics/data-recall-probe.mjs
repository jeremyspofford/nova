// Audit-only in-process scripted actor plus loopback Tev1 stand-in. No real model calls.
import { startNova, call } from '../../tests/ingest/support.js';
import { captureCheck } from '../../tests/support/capture-check.ts';

// 1: ordinary capture -> local synthetic screening -> deliberate promotion -> chat context.
const check = await captureCheck();
const calls=[];
const h=await startNova({agent:async o=>{calls.push({system:o.system,prompt:o.prompt});return {text:'Synthetic reply.',aborted:false};},privacy:'cloud-allowed',hub:check.tev1.url,decisions:check.core.decisions});
try {
 const c=h.nova.core;
 const s=c.capture.addScreenpipe({url:'http://127.0.0.1:3030'});
 c.capture.enable(s.id,{by:'console',since:'2026-01-01T00:00:00.000Z'});
 const r=c.capture.ingest(s.id,[{kind:'screen',at:new Date().toISOString(),text:'AUDIT_CAPTURE_RECALL_CANARY synthetic botanical itinerary.',app:'Editor',external_id:'audit-recall-1'}],'api');
 await c.capture.screen();
 const event=c.capture.event(r.kept[0]);
 const promoted=c.capture.promote({event_ids:r.kept},'console');
 h.nova.runner.memory.sync();
 const screensBefore=c.db.get('SELECT COUNT(*) n FROM ingest_screen').n;
 await h.run('What have I saved recently?');
 console.log(JSON.stringify({scenario:'promoted-capture-in-actor-context',screeningState:event.sensitivity,promotedSource:promoted.memory.source,actorCalls:calls.length,systemIncludesCaptureCanary:calls.some(x=>x.system.includes('AUDIT_CAPTURE_RECALL_CANARY')),additionalIngestScreens:c.db.get('SELECT COUNT(*) n FROM ingest_screen').n-screensBefore,actualActor:'in-process scripted fake; no remote send'},null,2));
} finally {await h.close();await check.close();}

// 2: a note forgotten after model step one remains in the frozen recall array at step two.
let release;
const paused=new Promise(r=>{release=r;});
let entered;
const firstCall=new Promise(r=>{entered=r;});
const later=[];
const q=await startNova({agent:async o=>{later.push({system:o.system,prompt:o.prompt});if(later.length===1){entered();await paused;return {text:call('nova_devices',{}),aborted:false};}return {text:'Synthetic reply after tool.',aborted:false};},privacy:'local-only',hub:'http://127.0.0.1:9'});
try {
 const note=q.nova.runner.memory.note({text:'AUDIT_FORGET_MIDTURN_CANARY synthetic cinnamon orchard details.',from:'audit-old-turn'},new Date('2026-09-01T12:00:00Z'));
 const run=q.run('Recall cinnamon orchard details');
 await firstCall;
 const before=q.nova.runner.memory.search('cinnamon orchard');
 q.nova.runner.memory.forget(note.id);
 const after=q.nova.runner.memory.search('cinnamon orchard');
 release();
 await run;
 console.log(JSON.stringify({scenario:'forget-between-actor-calls',before:before.length,after:after.length,actorCalls:later.length,secondPromptStillContainsDeletedNote:later[1]?.prompt.includes('AUDIT_FORGET_MIDTURN_CANARY')??null,actualActor:'in-process scripted fake; no remote send'},null,2));
} finally {release();await q.close();}
