// Read-only follow-up on the owned synthetic instance: source label/link and device Models door.
import {readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {chromium} from 'playwright-core';
import {start,halt,ROOT} from '../../tests/acceptance/support.ts';
const output=new URL('../evidence/',import.meta.url).pathname;
const report=JSON.parse(readFileSync(output+'product-workflows.json','utf8'));
if(!report.home.startsWith('/tmp/nova-astra-product-workflows-'))throw new Error('Refusing non-audit home');
const egress=join(dirname(report.home),'egress.log');
const nova=await start({HOME:report.userHome,NOVA_HOME:report.home,NOVA_PORT:'0',NOVA_EGRESS_LOG:egress,TZ:'UTC',NOVA_VAULT_KEY:'file',NOVA_AGENT_CMD:`${process.execPath} ${join(ROOT,'scripts/fake-agent.js')}`,NOVA_AGENT_EGRESS:'none'});
const base=`http://127.0.0.1:${nova.port}`;report.additionalInstances.push({base,home:report.home,purpose:'Read-only source/Models child follow-up; previous fixture processes stopped'});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-background-networking']});
const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'dark',reducedMotion:'reduce',serviceWorkers:'block'});
const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
const save=()=>{report.egress=readFileSync(egress,'utf8');writeFileSync(output+'product-workflows.json',JSON.stringify(report,null,2)+'\n');};
async function snap(name,extra={}){report.rows.push({name,result:'tested-pass',instance:base,viewport:{width:1440,height:900},...extra,url:page.url(),text:await page.locator('body').innerText(),errors:[...errors]});save();await page.screenshot({path:output+`product-workflow-${name}.png`});console.log(name);}
try{
 await page.goto(base+'/memory');await page.locator('#memory .memory-item[data-id]').first().waitFor();
 const source=page.locator('#memory .memory-item[data-id] .memory-source').first();
 await snap('source-label-dom',{result:'tested-fail',finding:'NOVA-086',sourceText:await source.innerText(),sourceHtml:await source.innerHTML(),sourceLinks:await source.locator('a').count(),storedRecords:await(await fetch(base+'/api/v1/memory')).json()});
 await page.locator('#rail a[data-dest="settings"]').click();await page.locator('a.settings-cat[data-cat="devices"]').click();
 await page.locator('#settings-devices [data-action="device-models"]').first().click();await page.waitForURL(/#models-on-/);await page.locator('[data-action="dm-back"]').waitFor();
 await snap('hub-models-child',{canonicalUrl:page.url()});
 await page.locator('[data-action="dm-back"]').click();await page.waitForURL(/#devices/);await snap('hub-models-back');
}catch(e){report.rows.push({name:'source-models-follow-up',result:'blocked',instance:base,error:String(e),text:await page.locator('body').innerText()});console.log(String(e));save();}
finally{save();writeFileSync(output+'product-settings-child-server.log',nova.out.join(''));await browser.close();await halt(nova);}
