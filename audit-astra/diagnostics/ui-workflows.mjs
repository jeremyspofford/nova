import {chromium} from 'playwright-core';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {blank,halt,until} from '../../tests/acceptance/support.ts';
import {finishSetup} from '../../tests/ui/support.ts';
const out='/workspace/nova-audit-astra/audit-astra/evidence/';
const m=blank('nova-astra-ui-workflow-');const nova=await m.start({NOVA_AGENT_CMD:'node /workspace/nova-audit-astra/scripts/fake-agent.js',NOVA_AGENT_EGRESS:'none'});
await finishSetup(m,{passkeys:false});
const b=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-background-networking']});
const c=await b.newContext({viewport:{width:1440,height:900},colorScheme:'dark',reducedMotion:'reduce',serviceWorkers:'block'});
const p=await c.newPage();p.setDefaultTimeout(12000);
const rows=[];const errors=[];p.on('pageerror',e=>errors.push(String(e)));
const save=()=>writeFileSync(out+'ui-workflows.json',JSON.stringify({instance:m.base,home:m.home,source:'d948aa0a',fixture:'scripts/fake-agent.js; no model; setup seeded over API; service worker blocked in workflow harness',rows},null,2));
async function snap(name,details={}){await p.waitForTimeout(250);const row={name,...details,url:p.url(),text:await p.locator('body').innerText(),errors:[...errors]};errors.length=0;rows.push(row);save();await p.screenshot({path:out+'workflow-'+name+'.png'});console.log(name);return row;}
async function step(name,fn){try{await fn();}catch(e){rows.push({name,result:'blocked',error:String(e),text:await p.locator('body').innerText()});save();console.log(name+' ERROR '+String(e));}}
async function nav(dest){await p.locator('#rail a[data-dest="'+dest+'"]').click();await p.waitForTimeout(350);}
try{
 await p.goto(m.base+'/new');
 await step('empty-and-draft',async()=>{
  const requests=[];p.on('request',q=>{if(q.method()==='POST')requests.push(q.url());});
  const disabled=await p.locator('#send').isDisabled();await p.getByRole('button',{name:'What do you remember about me?',exact:true}).click();
  await snap('suggestion-fills-only',{sendInitiallyDisabled:disabled,draft:await p.locator('#input').inputValue(),posts:requests});
  const draft='Draft for the audit. '+('A long neutral planning note. '.repeat(100));await p.locator('#input').fill(draft);
  await p.setViewportSize({width:390,height:844});await snap('draft-phone',{preserved:await p.locator('#input').inputValue()===draft});
  await p.setViewportSize({width:360,height:360});await snap('draft-cover',{preserved:await p.locator('#input').inputValue()===draft});
  await p.setViewportSize({width:1440,height:900});await p.reload();await p.waitForTimeout(350);await snap('draft-reload',{preserved:await p.locator('#input').inputValue()===draft});await p.locator('#input').fill('');
 });
 await step('chat-memory',async()=>{
  await p.locator('#input').fill('remember the audit garden has blue irises');await p.locator('#send').click();
  await p.waitForFunction(()=>document.querySelector('#thread')?.textContent.includes("Got it. I'll remember that."));
  await p.waitForTimeout(700);await snap('chat-memory-created');
  await nav('memory');await snap('memory-created');
  const data=await m.get('/api/memory');rows.push({name:'memory-api-after-chat',data});save();
 });
 await step('task-create-complete',async()=>{
  const body={title:'Write audit checklist',owner:'workspace',goal:'Write a neutral checklist and verify the file',inputs:{action:'write',path:'audit-checklist.md',content:'# Audit checklist\n\n- Check the garden.\n'},evidence_required:[{kind:'read_back',target:'workspace:audit-checklist.md',note:'Read the saved file'}],privacy_mode:'local-only',approval_tier:0};
  const r=await m.send('POST','/api/v1/tasks',body);rows.push({name:'create-task-api',status:r.status,body:r.body});save();
  if(r.status===201){const final=await until(()=>m.get('/api/v1/tasks/'+r.body.id),x=>['done','failed','waiting'].includes(x.state));rows.push({name:'task-final',final});save();}
  await nav('tasks');await snap('tasks-completed');
  const verified=p.getByRole('button',{name:/Verified: see the evidence/}).first();if(await verified.count()){await verified.click();await snap('task-evidence');await p.keyboard.press('Escape');}
  const bad=await m.send('POST','/api/v1/tasks',{...body,title:'Unsafe audit path control',inputs:{action:'write',path:'../outside.md',content:'synthetic'}});rows.push({name:'invalid-task-path-create',status:bad.status,body:bad.body});save();
  if(bad.status===201){rows.push({name:'invalid-task-path-result',body:await until(()=>m.get('/api/v1/tasks/'+bad.body.id),x=>['failed','waiting','done'].includes(x.state))});save();}
 });
 await step('failure-recovery',async()=>{
  await nav('chat');await p.locator('#input').fill('fail');await p.locator('#send').click();await p.waitForTimeout(1500);await snap('chat-failure');
  await p.locator('#input').fill('remember this recovery marker is synthetic');await p.locator('#send').click();await p.waitForTimeout(1600);await snap('chat-recovery');
 });
 await step('settings-persist',async()=>{await nav('settings');await p.getByRole('link',{name:/You and Nova/}).click();await snap('settings-controls');});
 await step('back-navigation',async()=>{await nav('memory');await nav('tasks');await p.goBack();await snap('back-navigation',{expected:'/memory',actual:new URL(p.url()).pathname});});
 await step('keyboard',async()=>{await p.keyboard.press('Control+k');await snap('palette-keyboard');await p.keyboard.press('Escape');rows.push({name:'palette-escape',active:await p.evaluate(()=>document.activeElement?.outerHTML)});save();});
} finally{save();await b.close();await halt(nova);}
