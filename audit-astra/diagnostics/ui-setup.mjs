import {chromium} from 'playwright-core';
import {writeFileSync} from 'node:fs';
const b=await chromium.connectOverCDP('http://127.0.0.1:9223');const p=b.contexts()[0].pages()[0];
const rows=[];const out='/workspace/nova-audit-astra/audit-astra/evidence/';
for(const answer of ['yes','Alex','not-a-timezone','America/New_York','keep','plainly','local-only','skip','skip','yes']) {
 const before=await p.locator('body').innerText();
 if(!await p.locator('#setup-input').isVisible()){rows.push({answer,stopped:true,before});break;}
 await p.locator('#setup-input').fill(answer);await p.locator('#setup-input').press('Enter');await p.waitForTimeout(250);
 const after=await p.locator('body').innerText();rows.push({answer,before,after});
 if(answer==='not-a-timezone')await p.screenshot({path:out+'setup-invalid-timezone.png'});
 if(answer==='America/New_York'){await p.reload();await p.waitForTimeout(300);rows.push({action:'reload',text:await p.locator('body').innerText()});}
}
await p.waitForTimeout(800);await p.screenshot({path:out+'setup-finish.png',fullPage:true});
writeFileSync(out+'setup-workflow.json',JSON.stringify(rows,null,2));
console.log((await p.locator('body').innerText()).slice(-10000));
console.log(await p.locator('button:visible,input:visible,textarea:visible').evaluateAll(es=>es.map(e=>({tag:e.tagName,id:e.id,text:e.textContent,placeholder:e.getAttribute('placeholder')}))));
process.exit(0);
