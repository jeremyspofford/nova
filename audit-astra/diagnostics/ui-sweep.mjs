import {chromium} from 'playwright-core';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const b=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-background-networking']});
const out='/workspace/nova-audit-astra/audit-astra/evidence/';mkdirSync(out+'screens',{recursive:true});
const axe=readFileSync('/workspace/nova-audit-astra/node_modules/axe-core/axe.min.js','utf8');
const routes=['/','/chat','/new','/tasks','/memory','/automations','/skills','/activity','/health','/settings','/capture','/topology','/about','/changelog','/pipeline','/styleguide?entry=jarvis','/pair'];
const cats=['you','appearance','privacy','connections','models','devices','capture','services','about','security','backups','config','danger'];
const rows=JSON.parse(readFileSync(out+'ui-sweep.json','utf8'));const errors=[];

for(const [posture,width,height] of [['desktop',1440,900],['phone',390,844],['cover',360,360]]){

 for(const route of [...routes,...cats.map(x=>'/settings?cat='+x)]){
  if(rows.some(r=>r.route===route&&r.posture===posture))continue;
  const c=await b.newContext({viewport:{width,height},colorScheme:'dark',reducedMotion:'reduce'});const p=await c.newPage();p.on('pageerror',e=>errors.push(String(e)));
  const name=(route==='/'?'home':route.replace(/^\//,'').replace(/[^a-z0-9]+/gi,'-'));
  const t=performance.now();await p.goto('http://127.0.0.1:4418'+route,{waitUntil:'commit',timeout:15000});await p.waitForTimeout(1000);
  const row={route,posture,width,height,elapsed_ms:Math.round(performance.now()-t),url:p.url(),text:await p.locator('body').innerText(),errors:[...errors]};errors.length=0;
  row.geometry=await p.evaluate(()=>({viewport:{w:innerWidth,h:innerHeight},doc:{w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight},overflows:[...document.querySelectorAll('main,section,article,input,textarea,button,select')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left<innerWidth&&(r.right>innerWidth+2||r.left< -2)}).map(e=>({tag:e.tagName,id:e.id,cl:e.className,text:e.textContent?.slice(0,100),rect:e.getBoundingClientRect().toJSON()})).slice(0,20),smallTargets:[...document.querySelectorAll('button,a,input,select')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0&&(r.width<24||r.height<24)}).map(e=>({tag:e.tagName,text:(e.textContent||e.getAttribute('aria-label'))?.slice(0,80),rect:e.getBoundingClientRect().toJSON()})).slice(0,20)}));
  if(posture!=='cover'&&!route.startsWith('/styleguide')&&!route.startsWith('/pair')){
   await p.evaluate(axe);const a=await p.evaluate(async()=>await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));
   row.axe=a.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,help:v.help,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary,html:n.html}))}));
  }
  await p.screenshot({path:out+'screens/'+posture+'-'+name+'.png'});rows.push(row);writeFileSync(out+'ui-sweep.json',JSON.stringify(rows,null,2));
  console.log(JSON.stringify({route,posture,overflow:row.geometry.overflows.length,violations:row.axe?.map(v=>[v.id,v.nodes.length]),errors:row.errors}));await c.close();
 }
}
await b.close();process.exit(0);
