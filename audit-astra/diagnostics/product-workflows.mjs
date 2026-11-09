// Audit-only real UI workflow on an owned disposable home. No real model or integration.
import {createServer} from 'node:http';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {blank,halt,until,ROOT} from '../../tests/acceptance/support.ts';
import {seedUserHome} from '../../tests/support/onboard-home.ts';
const output=new URL('../evidence/',import.meta.url).pathname;
const discoveryHits=[];
const fake=createServer((req,res)=>{discoveryHits.push(req.url);res.writeHead(404,{'content-type':'application/json'});res.end('{"fixture":"no services"}');});
await new Promise(r=>fake.listen(0,'127.0.0.1',r));
const fakePort=fake.address().port;
const m=blank('nova-astra-product-workflows-');
seedUserHome(m.env.HOME);
const nova=await m.start({NOVA_AGENT_CMD:`${process.execPath} ${join(ROOT,'scripts/fake-agent.js')}`,NOVA_AGENT_EGRESS:'none',NOVA_DISCOVERY_PORTS:`model-runtime=${fakePort},screenpipe=${fakePort},home-assistant=${fakePort}`});
const rows=[];
const setup=[];
const errors=[];
let browser;
let page;
const save=()=>writeFileSync(output+'product-workflows.json',JSON.stringify({baseline:'d948aa0a442a9f930b86f4516eeea21981b76714',instance:m.base,home:m.home,userHome:m.env.HOME,fixture:'seedUserHome synthetic notes; blank acceptance harness with egress guard; local 404 service-discovery stand-in; fake-agent.js for optional digest; no actual model/integration. Setup prepared via API; subsequent named workflow changes are actual browser clicks.',viewport:{width:1440,height:900},theme:'Nebula dark',serviceWorkers:'blocked',setup,discoveryHits,rows,errors,egress:readFileSync(m.egress,'utf8')},null,2)+'\n');
async function snap(name,extra={}){const row={name,result:'tested-pass',url:page.url(),...extra,text:await page.locator('body').innerText()};rows.push(row);save();await page.screenshot({path:output+`product-workflow-${name}.png`});console.log(name);return row;}
async function step(name,fn){try{await fn();}catch(e){rows.push({name,result:'blocked',error:String(e),text:await page.locator('body').innerText().catch(()=>'(no page)')});save();console.log(`${name}: ${String(e)}`);}}
async function nav(dest){await page.locator(`#rail a[data-dest="${dest}"]`).click();await page.waitForTimeout(200);}
try{
 const answers={device:'new',roles:'yes',backend:'yes',user_name:'Audit Person',timezone:'yes',nova_name:'keep',directness:'plainly',privacy:'keep everything on this machine',discover:'this computer',import:'notes',first_task:'no'};
 for(let n=0;n<18;n++){
  const view=await m.get('/api/v1/setup');if(view.done)break;
  const text=answers[view.step];assert.ok(text,`Unexpected setup step ${view.step}`);
  const r=await m.send('POST','/api/v1/setup/messages',{text});setup.push({step:view.step,answer:text,status:r.status,reply:r.body.reply});assert.equal(r.status,200);save();
 }
 const seeded=await m.get('/api/ memory'.replace(' ',''));
 assert.equal(seeded.candidates.length,2,'Two seeded note candidates');rows.push({name:'seeded-candidates',result:'tested-pass',data:seeded});save();
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-background-networking']});
 const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'dark',reducedMotion:'reduce',serviceWorkers:'block'});
 page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(m.base+'/');await page.waitForSelector('html[data-ready]');
 await step('candidate-keep-drop',async()=>{
  await nav('memory');await page.locator('#memory [data-candidate]').first().waitFor();await snap('candidates-before');
  const garden=page.locator('#memory [data-candidate]').filter({hasText:'Garden plans'});await garden.locator('[data-action="keep-candidate"]').click();
  await page.waitForFunction(()=>!Array.from(document.querySelectorAll('#memory [data-candidate]')).some(e=>e.textContent.includes('Garden plans')));
  const reading=page.locator('#memory [data-candidate]').filter({hasText:'Reading list'});await reading.locator('[data-action="drop-candidate"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#memory [data-candidate]').length===0);
  const data=await m.get('/api/memory');assert.equal(data.candidates.length,0);assert.ok(data.sections.flatMap(s=>s.entries).some(e=>e.text.includes('Garden plans')));assert.ok(!data.sections.flatMap(s=>s.entries).some(e=>e.text.includes('Reading list')));
  await snap('kept-and-dismissed',{data,core:await m.get('/api/v1/memory')});
 });
 await step('memory-correct-forget-undo',async()=>{
  let item=page.locator('#memory .memory-item[data-id]').filter({hasText:'Garden plans'});const provenance=await item.locator('.memory-source').innerText();
  await item.getByRole('button',{name:'Edit',exact:true}).click();const changed='Synthetic garden correction: plant larkspur by the east fence.';await page.getByRole('textbox',{name:'Edit this memory'}).fill(changed);await page.getByRole('textbox',{name:'Edit this memory'}).press('Enter');
  await page.waitForFunction(t=>document.querySelector('#memory')?.textContent.includes(t),changed);
  await until(()=>m.get('/api/memory'),d=>d.sections.flatMap(s=>s.entries).some(e=>e.text===changed));
  await page.reload();await page.waitForSelector('html[data-ready]');await page.getByText(changed,{exact:true}).waitFor();
  await snap('correction-reload',{provenanceBefore:provenance,core:await m.get('/api/v1/memory')});
  item=page.locator('#memory .memory-item[data-id]').filter({hasText:changed});await item.getByRole('button',{name:'Forget',exact:true}).click();
  await page.waitForFunction(t=>!document.querySelector('#memory')?.textContent.includes(t),changed);
  const beforeUndo=await m.get('/api/v1/memory');const undo=page.getByRole('button',{name:'Undo',exact:true});const offered=await undo.count();
  // Take evidence without delaying the short-lived undo control.
  rows.push({name:'forgotten',result:'tested-pass',undoOffered:offered>0,core:beforeUndo});save();
  if(offered){await undo.click();await page.getByText(changed,{exact:true}).waitFor();await snap('forget-undo',{core:await m.get('/api/v1/memory')});}
  else await snap('forget-no-undo');
 });
 await step('settings-persistence',async()=>{
  await nav('settings');await page.locator('a.settings-cat[data-cat="you"]').click();await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Audit Rowan');
  await page.locator('[data-action="save-profile"][data-field="you-name"]').click();await until(()=>m.get('/api/v1/profile'),p=>p.user?.name==='Audit Rowan');
  await page.reload();await page.waitForSelector('html[data-ready]');await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'Audit Rowan');
  await snap('setting-reload',{profile:await m.get('/api/v1/profile')});
 });
 await step('digest-enable-pause',async()=>{
  await nav('automations');const offer=page.locator('.skill.is-available').filter({hasText:'Morning digest'});await offer.getByRole('button',{name:'Turn on',exact:true}).click();
  const schedule=page.locator('.schedule').filter({hasText:'Morning digest'});await schedule.getByRole('button',{name:'Pause',exact:true}).waitFor();await snap('digest-enabled',{schedules:await m.get('/api/schedules')});
  await schedule.getByRole('button',{name:'Pause',exact:true}).click();await schedule.getByRole('button',{name:'Resume',exact:true}).waitFor();
  await page.reload();await page.waitForSelector('html[data-ready]');await page.locator('.schedule').filter({hasText:'Morning digest'}).getByRole('button',{name:'Resume',exact:true}).waitFor();
  await snap('digest-paused-reload',{schedules:await m.get('/api/schedules')});
 });
}catch(e){rows.push({name:'harness',result:'blocked',error:String(e)});console.log(String(e));}
finally{save();writeFileSync(output+'product-workflows-server.log',nova.out.join(''));await browser?.close();await halt(nova);await new Promise(r=>fake.close(r));}
