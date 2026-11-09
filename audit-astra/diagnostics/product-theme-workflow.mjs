// Resume ONLY the audit-owned synthetic home for a bounded Appearance interaction.
import {readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {start,halt,ROOT} from '../../tests/acceptance/support.ts';
const output=new URL('../evidence/',import.meta.url).pathname;
const report=JSON.parse(readFileSync(output+'product-workflows.json','utf8'));
if(!report.home.startsWith('/tmp/nova-astra-product-workflows-'))throw new Error('Refusing non-audit home');
const egress=join(dirname(report.home),'egress.log');
const nova=await start({HOME:report.userHome,NOVA_HOME:report.home,NOVA_PORT:'0',NOVA_EGRESS_LOG:egress,TZ:'UTC',NOVA_VAULT_KEY:'file',NOVA_AGENT_CMD:`${process.execPath} ${join(ROOT,'scripts/fake-agent.js')}`,NOVA_AGENT_EGRESS:'none'});
const base=`http://127.0.0.1:${nova.port}`;
report.additionalInstances=[{base,home:report.home,purpose:'Appearance fixture resumed; original instance stopped'}];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-background-networking']});
const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,colorScheme:'dark',reducedMotion:'reduce',serviceWorkers:'block'});
const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
const save=()=>{report.egress=readFileSync(egress,'utf8');writeFileSync(output+'product-workflows.json',JSON.stringify(report,null,2)+'\n');};
async function snap(name,extra={}){report.rows.push({name,result:'tested-pass',instance:base,viewport:{width:390,height:844},...extra,url:page.url(),theme:await page.evaluate(()=>document.documentElement.dataset.theme),text:await page.locator('body').innerText(),errors:[...errors]});save();await page.screenshot({path:output+`product-workflow-${name}.png`});console.log(name);}
try{
 await page.goto(base+'/settings#appearance');await page.locator('#appearance-where').waitFor();
 await page.getByRole('radio',{name:'This device',exact:true}).check();
 await page.locator('.ds-more-summary').click();
 await page.locator('.ds-card[data-ds="orb-teal"]').click();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='orb-teal');await page.locator('#appearance-undo [data-action="undo-ds"]').waitFor();
 await snap('theme-device-applied',{undoVisible:true,scope:await page.locator('#appearance-scope').innerText()});
 await page.locator('#appearance-undo [data-action="undo-ds"]').click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='nebula');await snap('theme-undo',{scope:await page.locator('#appearance-scope').innerText()});
 if(!(await page.locator('.ds-card[data-ds="orb-teal"]').isVisible()))await page.locator('.ds-more-summary').click();
 await page.locator('.ds-card[data-ds="orb-teal"]').click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='orb-teal');await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.theme==='orb-teal');
 const synced=await(await fetch(base+'/api/v1/design-systems/active')).json();assert.equal(synced.id,'nebula','Device override does not change synced default');
 await snap('theme-device-reload',{syncedDefault:synced.id,scope:await page.locator('#appearance-scope').innerText()});
}catch(e){report.rows.push({name:'theme-workflow',result:'blocked',instance:base,error:String(e),text:await page.locator('body').innerText()});console.log(String(e));save();}
finally{save();writeFileSync(output+'product-theme-server.log',nova.out.join(''));await browser.close();await halt(nova);}
