import {chromium} from 'playwright-core';
import {writeFileSync} from 'node:fs';
const b=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-background-networking']});
const rows=[];
for(const [route,view] of [['/','home'],['/chat','chat'],['/tasks','tasks'],['/settings#models','settings']]){
 for(let sample=0;sample<3;sample++){
  const c=await b.newContext({viewport:{width:390,height:844},colorScheme:'dark',reducedMotion:'reduce'});const p=await c.newPage();
  await p.addInitScript(()=>{window.auditPaint={lcp:null,cls:0};new PerformanceObserver(l=>{for(const e of l.getEntries())window.auditPaint.lcp=e.startTime;}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.auditPaint.cls+=e.value;}).observe({type:'layout-shift',buffered:true});});
  const t=performance.now();await p.goto('http://127.0.0.1:4418'+route,{waitUntil:'commit'});await p.waitForFunction(v=>document.body.dataset.view===v,view);const view_ms=performance.now()-t;
  await p.waitForTimeout(1200);rows.push({route,sample,view_ms:Math.round(view_ms),...await p.evaluate(()=>({paint:window.auditPaint,navigation:performance.getEntriesByType('navigation').map(n=>({ttfb:n.responseStart-n.requestStart,domContentLoaded:n.domContentLoadedEventEnd,transferSize:n.transferSize})),resources:performance.getEntriesByType('resource').length,resourceTransferBytes:performance.getEntriesByType('resource').reduce((s,r)=>s+r.transferSize,0)}))});await c.close();
 }
}
await b.close();const result={conditions:'Linux headless Chromium,390x844,dark,reduced motion,localhost,new context per sample; shared host with concurrent test activity; 3 samples/route; LCP/CLS observed for1.2s after view state only; not field vitals/INP/p75 certification',rows};
writeFileSync('/workspace/nova-audit-astra/audit-astra/evidence/ui-performance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
