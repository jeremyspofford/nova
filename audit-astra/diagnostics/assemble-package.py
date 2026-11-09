"""Assemble this audit's documents; never modifies product sources."""
from pathlib import Path
import csv,json,re,collections
root=Path(__file__).resolve().parents[1]
parts=list((root/'contributions').glob('*.md'))
findings={}
for path in parts:
    s=path.read_text()
    matches=list(re.finditer(r'^#{2,3} (NOVA-\d+) — (.+)$',s,re.M))
    for m in matches:
        rest=s[m.end():]
        end=re.search(r'^#{1,3} ',rest,re.M)
        body=rest[:end.start()] if end else rest
        findings[m[1]]={'title':m[2],'body':body.strip(),'source':path.name}
order=['001','020','023','021','005','002','003','004','081','086','085','084','040','082','083','080','041','006','042','120','121','100','044','043','045','046','022','060','061','062','063']
meta={
'001':('defect','high','P0'), '020':('defect','high','P1'),'023':('defect','high','P1'),'021':('defect','medium','P1'),
'005':('unmet commitment','high','P1'),'002':('investigation','high','P1'),'003':('unmet commitment','high','P1'),'004':('investigation','high potential','P1'),
'081':('defect','medium','P1'),'086':('defect','medium','P1'),'085':('defect','medium','P1'),'084':('defect','medium','P1'),
'040':('defect','medium','P1'),'082':('unmet commitment','medium','P1'),'083':('unmet commitment','medium','P2'),'080':('defect','medium','P1'),
'041':('unmet commitment','medium','P2'),'006':('improvement','medium','P2'),'042':('improvement','medium','P2'),'120':('defect','medium','P2'),
'121':('improvement','medium','P2'),'100':('improvement','medium','P2'),'044':('improvement','medium','P2'),'043':('defect','low','P2'),
'045':('investigation','high potential','P1'),'046':('investigation','low','P3'),'022':('improvement','low','P3'),
'060':('investigation','medium planning risk','P2 gated'),'061':('improvement','opportunity','P2 gated'),'062':('improvement','opportunity','P3 gated'),'063':('improvement','opportunity','P3 gated')}
lines=['# Prioritized implementation backlog','',
'Audit only. All records concern merged `d948aa0a442a9f930b86f4516eeea21981b76714`; runtime evidence is disposable and synthetic unless stated. Owner-deployed applicability is unknown. No item is implemented. The project builder owns implementation after consolidation. Research Part 3 is a parked owner decision and is deliberately absent from this implementation backlog.','',
'Severity is consequence, priority is sequence. Potential severity belongs to investigations and is not a confirmed incident. Estimates assume one familiar builder and existing harnesses; they exclude review/access delays and overlap. Graph estimates are proposals after existing ADR/owner gates. The index below is the consolidated triage authority if a working contribution uses a different priority.','',
'| ID | Category | Severity | Priority | Finding |','|---|---|---|---|---|']
index=[]
for num in order:
    key='NOVA-'+num;f=findings[key];cat,sev,pri=meta[num]
    lines.append(f'| [{key}](#{key.lower()}) | {cat} | {sev} | {pri} | {f["title"]} |')
    index.append({'id':key,'category':cat,'severity':sev,'priority':pri,'title':f['title'],'detail_source':'contributions/'+f['source'],'baseline':'d948aa0a442a9f930b86f4516eeea21981b76714','deployed':'unknown','status':'open; audit only'})
for num in order:
    key='NOVA-'+num;f=findings[key]
    lines += ['',f'<a id="{key.lower()}"></a>',f'## {key} — {f["title"]}','',f'Consolidated triage: **{meta[num][0]} · severity {meta[num][1]} · {meta[num][2]}**. Supporting review: [source](contributions/{f["source"]}).','',f['body']]
assembled='\n'.join(lines)+'\n'
assembled=assembled.replace('all Slice 1 criteria above', 'all [Slice 1 criteria](KNOWLEDGE-PLAN.md#three-independently-useful-shippable-slices)')
assembled=assembled.replace('**Acceptance / regression / effort:** Slice 2 criteria;', '**Acceptance / regression / effort:** [Slice 2 criteria](KNOWLEDGE-PLAN.md#three-independently-useful-shippable-slices);')
assembled=assembled.replace('**Acceptance / regression / effort:** Slice 3 criteria;', '**Acceptance / regression / effort:** [Slice 3 criteria](KNOWLEDGE-PLAN.md#three-independently-useful-shippable-slices);')
assembled=assembled.replace('source relations described above','source relations described in KNOWLEDGE-PLAN.md')
(root/'BACKLOG.md').write_text(assembled)
with (root/'BACKLOG.csv').open('w') as f:
    w=csv.DictWriter(f,fieldnames=list(index[0]));w.writeheader();w.writerows(index)
(root/'KNOWLEDGE-PLAN.md').write_text((root/'contributions/knowledge-plan.md').read_text())

rows=[]
def add(surface,role,theme,state,result,evidence,instance='disposable merged baseline',classification='observed'):
    rows.append(dict(surface_workflow=surface,role_mode=role,theme_viewport=theme,state=state,result=result,evidence=evidence,instance=instance,baseline='d948aa0a442a9f930b86f4516eeea21981b76714',evidence_class=classification))
for fn in ['ui-sweep.json','ui-settings-sweep.json']:
    for r in json.loads((root/'evidence'/fn).read_text()):
        if '?cat=' in r['route']:continue
        geometry=r['geometry']; bad=geometry['doc']['w']>r['width']+1 or bool(r['errors'])
        state='initial/empty fixture; route render, geometry and screenshot only'
        if r['route']=='/pair':state='unconfigured pairing/console boundary page; no actual enrollment'
        if 'styleguide' in r['route']:state='Jarvis design specimen only; no runtime theme'
        if 'axe' in r:state+='; WCAG-tagged axe scan'
        add(r['route'],'console/local-only; no models',f'Nebula dark/reduced motion; Chromium {r["width"]}x{r["height"]}',state,'tested-fail' if bad or r.get('axe') else 'tested-pass',f'evidence/{fn}: {r["posture"]} {r["route"]}; evidence/screens/','http://127.0.0.1:4418 synthetic main home','observed render (not full workflow)')
for r in json.loads((root/'evidence/ui-supplement.json').read_text()):
    add(r['route'],'console/local-only',f'Nebula {r["scheme"]}; Chromium390x844','initial rendered state/alias/styleguide','tested-pass','evidence/ui-supplement.json; evidence/screens/','http://127.0.0.1:4418','observed render only')

# Preserve contributors' six-column coverage rows; the evidence classification prevents
# source inspection and retrieved CI records from masquerading as live user interaction.
for path in parts:
    for ln in path.read_text().splitlines():
        if not ln.startswith('|'):continue
        cells=[c.strip() for c in ln.strip().strip('|').split('|')]
        if len(cells)!=6:continue
        match=re.match(r'(tested-pass|tested-fail|blocked|untested)\b',cells[4])
        if not match:continue
        cls='observed synthetic or source inspection; see cited contribution for exact method'
        if 'source' in (cells[1]+' '+cells[3]).lower():cls='source inspection; not a functional runtime claim'
        if 'CI' in cells[0]:cls='retrieved remote CI evidence'
        add(cells[0],cells[1],cells[2],cells[3],match[1],f'contributions/{path.name}; {cells[5]}',classification=cls)

manual=[
('Setup','console/local-only','Nebula light; desktop browser','invalid timezone, correction, reload, real first task','tested-pass','evidence/setup-workflow.json; setup-finish.png'),
('Chat suggestion / empty send','console/local-only; fake actor','Nebula dark1440x900','empty disabled; suggestion fills without sending','tested-pass','evidence/ui-workflows.json:suggestion-fills-only'),
('Long chat draft','console/local-only','1440x900→390x844→360x360; Chromium','resize and reload retain draft','tested-pass','evidence/ui-workflows.json:draft-*'),
('Chat→memory','console/local-only; synthetic actor','Nebula dark1440x900','neutral fact retained and visible source text','tested-pass','evidence/ui-workflows.json:chat-memory-created/memory-created'),
('Task create→verify→evidence','console/local-only; deterministic worker','Nebula dark1440x900','API creation; actual Verify button and read-back sheet','tested-pass','evidence/ui-workflows.json:task-final/task-evidence'),
('Invalid task input','console/local-only','API','missing evidence target rejected400; outside workspace waits with reason','tested-pass','evidence/ui-workflows-initial-harness.json; ui-workflows.json'),
('Actor failure→new successful message','console/local-only; fake actor','Nebula dark1440x900','error Details/Try again; next message succeeds','tested-pass','evidence/ui-workflows.json:chat-failure/chat-recovery'),
('Keyboard palette / browser Back','console/local-only','Nebula desktop','Ctrl+K, Escape; Back returns Memory','tested-pass','evidence/ui-workflows.json'),
('Local performance samples','console/local-only','Nebula dark390x844; Chromium; reduced motion','12 new-context samples; short window; concurrent load','tested-pass','evidence/ui-performance.json'),
('Status artwork fallback','read-only styleguide','forced Canvas2D; reduced motion','idle/thinking pixel-identical; ARIA differs','tested-fail','evidence/visual-mark-fallback.json/png; NOVA-120'),
('Owner runtime build / watcher','owner host','Health and version','expected4318/log unavailable','blocked','BASELINE.md; no owner-deploy assertion'),
('Real cloud/local chat quality','any mode','actual providers','no model calls authorized for this audit','untested','Privacy tests and fake actors establish routing/orchestration only'),
('Real Tev1 screening performance','local','actual model/hardware','current committed eval files inspected; no new eval','untested','contributions/privacy.md'),
('Research Part3 evaluation','owner decision','actual models','parked local-only exception; NO eval run','blocked','REQUEST.txt; REPORT.md section8'),
('Complete threat-model review','security reviewer','restricted source','intentionally not ingested by cloud reviewer','blocked','BASELINE.md'),
('All-process egress incl DNS/UDP/native children','operator/local-only','OS network lab','permitted LAN vs prohibited external sinks','untested','NOVA-004'),
('Physical phone pairing / revoke / passkeys','paired person/approver','physical iPhone/Android','actual enrollment, expiry and recovery','blocked','No physical devices or owner host access'),
('Physical foldable / installed iOS / touch assistive use','all roles','hardware/AT','hinges/safe areas/status bar/screen reader','untested','Browser emulation is separately identified'),
('Live connectors and credentialed workflows','all roles/modes','actual third-party services','mail, home, browser accounts, infra/network','untested','Synthetic boundaries/source reviewed; no live account mutation'),
('Session expiry and complete role matrix','paired reader/person/approver','all themes/viewports','expiry/revocation plus stale UI combinations','untested','Selected synthetic boundary checks only'),
('All7themes×states×roles×postures','all','full Cartesian product','beyond sampled Nebula/Orb Teal/Jarvis specimens','untested','Risk-based samples and existing tests only'),
('Jarvis live theme','console','all viewports','no manifest/Appearance choice exists','untested','Styleguide specimen tested; not a selectable shipped theme'),
('Large graph/3D user tasks','future capability','2D/3D/accessibility','not implemented; design only','untested','KNOWLEDGE-PLAN.md'),
('Digest execution/content quality','console/local-only','synthetic schedule','enable/pause tested; actual scheduled actor run not exercised in browser','untested','evidence/product-workflows.json'),
]
for r in manual:add(*r)
with (root/'COVERAGE.csv').open('w') as f:
    w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
summary={'rows':len(rows),'results':dict(collections.Counter(r['result'] for r in rows)),'findings':len(findings),'appearance_visits':90,'note':'Rows overlap workflows/observations and are not a coverage percentage. Source inspection, synthetic fixture, remote CI and own runtime are explicitly distinguished.'}
(root/'evidence/package-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
