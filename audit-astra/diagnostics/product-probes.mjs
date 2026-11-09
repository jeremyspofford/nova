// Audit-only, synthetic, no network and no product edits.
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { pipelineView } from '../../src/core/pipeline.ts';
import { firstAction } from '../../src/core/onboard/first.ts';
import { IMPORT_DIR } from '../../src/core/self.ts';
import { loadConfig } from '../../src/config.js';
import { join } from 'node:path';
const root = new URL('../../', import.meta.url).pathname;
const pipeline = pipelineView(root);
const selected = pipeline.workstreams.flatMap(w => w.items).filter(i => /adr-provider|jarvis-compositions|memory-compositions|M4$/.test(i.id));
const src = readFileSync(new URL('../../ui/js/app.js', import.meta.url), 'utf8');
const start = src.indexOf('let memoryLoad = null;');
const end = src.indexOf('\nfunction loadSkills()', start);
if (start < 0 || end < 0) throw new Error('Source range changed');
const reads = [];
const paints = [];
const state = { memory: null, memoryError: '', view: 'memory', session: {turns:[]} };
const context = vm.createContext({
  state,
  getJson: () => new Promise(resolve => reads.push(resolve)),
  memoryIndex: data => new Map(data.sections.flatMap(x => x.entries).map(x => [x.id, x])),
  renderMemoryView: () => paints.push(structuredClone(state.memory)),
  renderThread: () => {},
});
vm.runInContext(src.slice(start, end) + '\nglobalThis.auditLoadMemory = loadMemory;', context);
const older = context.auditLoadMemory();
const newer = context.auditLoadMemory();
reads[1]({sections:[{title:'Facts', entries:[]}], days:[], candidates:[], titles:{}});
await newer;
reads[0]({sections:[{title:'Facts', entries:[{id:'synthetic-old-memory', text:'Synthetic memory removed by the newer read'}]}], days:[], candidates:[], titles:{}});
await older;
const result = {
  baseline: 'd948aa0a442a9f930b86f4516eeea21981b76714',
  method: 'Pipeline called against baseline records. Memory race executes the exact loadMemory source in a VM with two deferred synthetic GET promises; no browser, network, or real memory data.',
  pipeline: {counts:pipeline.counts, selected},
  memoryRace: {paintOrder: paints, final: state.memory, staleResponseWon: state.memory.sections[0].entries.length === 1},
  onboardingImport: {
    action:firstAction(0),
    configuredHome:loadConfig({NOVA_HOME:'/tmp/audit-synthetic-nova-home'},root).home,
    actualImportFolder:join(loadConfig({NOVA_HOME:'/tmp/audit-synthetic-nova-home'},root).home,IMPORT_DIR),
    note:'Source APIs only: no folder or instance created. Displayed path has no dependency on configured home.',
  },
};
writeFileSync(new URL('../evidence/product-probes.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({pipelineSelected: selected.map(i=>({id:i.id,state:i.state})), memoryRace:result.memoryRace}, null, 2));
