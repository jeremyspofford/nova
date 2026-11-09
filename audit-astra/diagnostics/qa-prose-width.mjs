// Independent measurement of the existing M9 narrow-tablet failure; synthetic fixture only.
import { writeFileSync } from 'node:fs';
import { seeded, settled, CHAT } from '../../tests/ui/m9-support.ts';
import { browser, device, still } from '../../tests/ui/support.ts';
import { stop } from '../../tests/acceptance/support.ts';
const b = await browser();
if (typeof b === 'string') throw new Error(b);
const {m,nova}=await seeded('nova-qa-prose-');
const results=[];
try {
  for(const width of [840,1024,1280]) {
    const d=await device(b,{width,height:900});
    await d.page.goto(`${m.base}/c/${CHAT}`);
    await settled(d.page,'chat');
    const room=await d.page.evaluate(()=>document.body.dataset.room);
    if(room==='yes') {await d.page.locator('#aside-toggle').click();await d.page.waitForFunction(()=>document.body.dataset.aside==='on');}
    await still(d.page);
    const measurements=await d.page.evaluate(()=>[...document.querySelectorAll('#main p, #main li')].filter(e=>e.checkVisibility()&&e.getBoundingClientRect().width>0&&(e.textContent??'').trim().length>=160).map(e=>{
      const cs=getComputedStyle(e), probe=document.createElement('span'); probe.textContent='0';probe.style.font=cs.font;probe.style.position='absolute';document.body.append(probe);
      const ch=probe.getBoundingClientRect().width;probe.remove();
      const contentWidth=e.getBoundingClientRect().width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);
      return {tag:e.tagName,className:e.className,textLength:e.textContent.length,font:cs.font,ch,contentWidth,chars:contentWidth/ch};
    }));
    results.push({width,room,expandedAside:room==='yes',measurements,errors:d.errors});
    await d.page.screenshot({path:new URL(`../evidence/qa-prose-${width}.png`,import.meta.url).pathname,fullPage:true});
    await d.ctx.close();
  }
} finally {await b.close();await stop(nova);}
writeFileSync(new URL('../evidence/qa-prose-width.json',import.meta.url),JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
