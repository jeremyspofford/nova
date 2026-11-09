// Controlled-response browser diagnostic. Does not write server data or call models.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-background-networking']});
const context = await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
const page = await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(String(e)));
const empty={sections:[{title:'Facts',entries:[]}],days:[],candidates:[],titles:{}};
const old={...empty,sections:[{title:'Facts',entries:[{id:'m1234abcd',text:'Synthetic old memory: should be absent after the newer response',by:'hand'}]}]};
let first=null;let count=0;
await page.route('**/api/memory',async route=>{
  count++;
  if(count===1){first=route;return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(empty)});
});
try{
  await page.goto('http://127.0.0.1:4418/memory',{waitUntil:'domcontentloaded',timeout:20000});
  await page.waitForFunction(()=>document.querySelector('#memory')?.textContent.includes('Nothing kept yet.'),{timeout:10000});
  const newerRendered=await page.locator('#memory').innerText();
  if(!first||count<2)throw new Error('Expected boot and route Memory requests');
  await first.fulfill({status:200,contentType:'application/json',body:JSON.stringify(old)});
  await page.waitForFunction(()=>document.querySelector('#memory')?.textContent.includes('Synthetic old memory'),{timeout:10000});
  const olderRendered=await page.locator('#memory').innerText();
  await page.screenshot({path:new URL('../evidence/product-memory-race.png',import.meta.url).pathname});
  const result={baseline:'d948aa0a442a9f930b86f4516eeea21981b76714',instance:'http://127.0.0.1:4418',method:'Real app in Chromium; GET /api/memory responses replaced with synthetic fixtures. Newer empty response fulfilled before delayed initial old response. No mutation or backend-forget operation performed.',requests:count,newerRendered,olderRendered,errors};
  writeFileSync(new URL('../evidence/product-memory-browser.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{await context.close();await browser.close();}
