import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
const home = mkdtempSync('/tmp/nova-source-grants-');
const root = join(home, 'connectors');
const paths = [root, join(root, 'gmail'), join(root, 'gmail/token.json'), join(home, 'unrelated')];
const code = `import { lstatSync } from 'node:fs';
const paths = JSON.parse(process.argv[1]);
for (let i=0; i<paths.length; i++) {
 let result;
 try { result = lstatSync(paths[i]).isDirectory() ? 'directory' : 'file'; }
 catch(e) { result = e.code; }
 console.log(JSON.stringify({ pathIndex:i, permitted:process.permission.has('fs.read',paths[i]), result }));
}`;
for (const existing of [false, true]) {
 if (existing) { mkdirSync(join(root,'gmail'),{recursive:true}); writeFileSync(join(root,'gmail/token.json'),'synthetic'); }
 for (const [label, grants] of [ ['slash',[root+'/']], ['exact',[root]], ['wildcard',[root+'/*']], ['exact-wildcard',[root,root+'/*']] ]) {
  const args = ['--permission', ...grants.map(p=>'--allow-fs-read='+p), '--input-type=module', '-e', code, JSON.stringify(paths)];
  const r = spawnSync(process.execPath,args,{env:{TZ:'UTC'},encoding:'utf8'});
  console.log(JSON.stringify({ existing, label, grants, exit:r.status, stdout:r.stdout, stderr:r.stderr }));
 }
}
chmodSync(join(root,'gmail'),0o000);
const denied = spawnSync(process.execPath,['--permission','--allow-fs-read='+root,'--input-type=module','-e',code,JSON.stringify(paths)],{env:{TZ:'UTC'},encoding:'utf8'});
console.log(JSON.stringify({ mode:'OS-denied',exit:denied.status,stdout:denied.stdout,stderr:denied.stderr }));
chmodSync(join(root,'gmail'),0o700);
