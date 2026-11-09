// Audit only: verifies whether the existing status artwork remains distinguishable
// without WebGL. No product source or runtime data is changed.
import {chromium} from 'playwright-core';
import {writeFileSync} from 'node:fs';
const out='/workspace/nova-audit-astra/audit-astra/evidence/';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
const context=await browser.newContext({viewport:{width:1200,height:900},colorScheme:'dark',reducedMotion:'reduce',serviceWorkers:'block'});
await context.addInitScript(()=>{
  const original=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(kind,...rest){return /webgl/.test(kind)?null:original.call(this,kind,...rest);};
});
const p=await context.newPage();
await p.goto('http://127.0.0.1:4418/styleguide?entry=status-icons',{waitUntil:'domcontentloaded',timeout:20000});
await p.waitForTimeout(500);
const result=await p.evaluate(async()=>{
  const {statusIcon}=await import('/js/status-icon.js');
  const holder=document.createElement('section');holder.id='audit-fallback-comparison';holder.style.cssText='display:flex;gap:24px;padding:24px;background:#111;color:white';
  document.body.prepend(holder);
  const entries=[];
  for(const state of ['idle','thinking','listening','working','speaking','needs-you','stopped','offline']){
    const wrap=document.createElement('div');wrap.textContent=state;const icon=statusIcon({status:state,size:96});wrap.append(icon);holder.append(wrap);entries.push({state,icon});
  }
  await new Promise(r=>setTimeout(r,300));
  const rows=entries.map(({state,icon})=>({state,renderer:icon.dataset.renderer,label:icon.getAttribute('aria-label'),pixels:icon.querySelector('canvas').toDataURL()}));
  const equal=[];for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)if(rows[i].pixels===rows[j].pixels)equal.push([rows[i].state,rows[j].state]);
  return {url:location.href,rows:rows.map(({pixels,...r})=>r),equal};
});
await p.locator('#audit-fallback-comparison').screenshot({path:out+'visual-mark-fallback.png'});
writeFileSync(out+'visual-mark-fallback.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
await browser.close();
