import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const c = b.contexts()[0];
const p = c.pages()[0] || await c.newPage();
p.setDefaultTimeout(10000);
const step = process.argv[2] || 'start';
const out = '/workspace/nova-audit-astra/audit-astra/evidence/';
if(step==='start') { await p.setViewportSize({width:1440,height:900}); await p.goto('http://127.0.0.1:4418'); await p.waitForTimeout(600); }
if(step==='click') { await p.getByRole('button',{name:process.argv[3],exact:true}).click(); await p.waitForTimeout(400); }
if(step==='fill') { await p.getByLabel(process.argv[3],{exact:true}).fill(process.argv[4]); }
if(step==='answer') { await p.locator('#setup-input').fill(process.argv[3]); await p.locator('#setup-input').press('Enter'); await p.waitForTimeout(300); }
if(step==='goto') { await p.goto('http://127.0.0.1:4418'+process.argv[3]); await p.waitForTimeout(500); }
if(step==='shot') { await p.screenshot({path:out+process.argv[3]+'.png',fullPage:true}); }
console.log(JSON.stringify({url:p.url(),text:await p.locator('body').innerText(),controls:await p.locator('input:visible,select:visible,textarea:visible,button:visible').evaluateAll(es=>es.map(e=>({tag:e.tagName,type:e.type,name:e.name,id:e.id,label:e.getAttribute('aria-label'),text:e.textContent?.trim().slice(0,120),placeholder:e.getAttribute('placeholder'),value:e.value,disabled:e.disabled})))},null,2));
process.exit(0);
