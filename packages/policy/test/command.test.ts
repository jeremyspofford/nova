import { describe, expect, it } from 'vitest';
import {
  checkCommandRule,
  classifyProgram,
  commandCoveredBy,
  commandMatchesRule,
  evaluateCommand,
  loadCommandRules,
  lookThrough,
  parseCommand,
  prefixMatchesRaw,
  programName,
  suggestPrefixRule,
} from '../src/command.ts';
import type { CommandRule } from '../src/types.ts';

const rule = (
  r: Partial<CommandRule> & Pick<CommandRule, 'pattern' | 'decision'>,
): CommandRule => ({
  id: r.id ?? 'r',
  scope: { kind: 'global' },
  matchExamples: ['x'],
  notMatchExamples: ['y'],
  source: 'user',
  ...r,
});

describe('parseCommand', () => {
  it('splits simple and compound commands into words without expanding', () => {
    expect(parseCommand('git status')).toEqual({
      parts: [['git', 'status']],
      certain: true,
      problems: [],
    });
    expect(parseCommand('a && b || c; d | e |& f & g\nh').parts).toEqual([
      ['a'],
      ['b'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
      ['g'],
      ['h'],
    ]);
    expect(parseCommand('echo "a b" \'c d\' e\\ f $HOME').parts).toEqual([
      ['echo', 'a b', 'c d', 'e f', '$HOME'],
    ]);
    expect(parseCommand('g\'i\'t "st"atus').parts).toEqual([['git', 'status']]);
    expect(parseCommand('echo "x\\"y\\$z\\q"').parts).toEqual([['echo', 'x"y$z\\q']]);
    expect(parseCommand('git \\\n  status').parts).toEqual([['git', 'status']]);
    expect(parseCommand('echo "a\\\nb"').parts).toEqual([['echo', 'ab']]);
    expect(parseCommand('ls # a comment\npwd').parts).toEqual([['ls'], ['pwd']]);
    expect(parseCommand('   ').parts).toEqual([]);
  });

  it('drops redirections and their targets', () => {
    expect(parseCommand('npm test > out.txt 2>&1').parts).toEqual([['npm', 'test']]);
    expect(parseCommand('>log git status').parts).toEqual([['git', 'status']]);
    expect(parseCommand('cat <<< "hi"').parts).toEqual([['cat']]);
    expect(parseCommand('cat >').problems).toContain('redirection without a target');
  });

  it('flattens subshells and groups', () => {
    expect(parseCommand('(cd x && make)').parts).toEqual([['cd', 'x'], ['make']]);
    expect(parseCommand('{ a; b; }').parts).toEqual([['a'], ['b']]);
    expect(parseCommand('(a').problems).toContain('unbalanced parentheses');
    expect(parseCommand('a)').problems).toContain('unbalanced parentheses');
  });

  it('marks what it cannot parse with certainty', () => {
    const p = (s: string) => parseCommand(s).problems;
    expect(p('echo $(id)')).toContain('command substitution');
    expect(p('echo `id`')).toContain('command substitution');
    expect(p('echo `id')).toContain('unbalanced quotes');
    expect(p('echo "$(id)"')).toContain('command substitution');
    expect(p('echo "`id`"')).toContain('command substitution');
    expect(p('echo $(( 1 + 2 ))')).toContain('command substitution');
    expect(p('echo $(id')).toContain('unbalanced parentheses');
    expect(p('echo ${X:-$(id)}')).toContain('command substitution');
    expect(p('echo ${X')).toContain('unbalanced braces');
    expect(parseCommand('echo ${HOME}/x').certain).toBe(true);
    expect(p('diff <(ls a) <(ls b)')).toContain('process substitution');
    expect(p('eval "rm -rf /"')).toContain('eval');
    expect(p("echo 'unterminated")).toContain('unbalanced quotes');
    expect(p('echo "unterminated')).toContain('unbalanced quotes');
    expect(p('for f in *; do rm $f; done')).toContain('shell control structure');
    expect(p('f() { rm -rf /; }')).toContain('function definition');
    expect(parseCommand('x', 9).problems).toContain('nested too deeply');
  });

  it('reads here-documents: quoted or plain bodies are fine, expansion is not', () => {
    expect(parseCommand("cat <<'EOF'\n$(id)\nEOF\necho done")).toMatchObject({
      parts: [['cat'], ['echo', 'done']],
      certain: true,
    });
    expect(parseCommand('cat <<EOF\nhello\nEOF').certain).toBe(true);
    expect(parseCommand('cat <<EOF\n$(id)\nEOF').problems).toContain(
      'here-document with expansion',
    );
    expect(parseCommand('cat <<-EOF\n\thello\n\tEOF\nls').parts).toEqual([['cat'], ['ls']]);
    expect(parseCommand('cat <<EOF\nhello').problems).toContain('unterminated here-document');
    expect(parseCommand('cat <<EOF').problems).toContain('unterminated here-document');
    expect(parseCommand('cat << ;').problems).toContain('here-document without a delimiter');
  });
});

describe('wrappers and programs', () => {
  it('looks through wrappers, assignments and shells', () => {
    const last = (s: string) => lookThrough(parseCommand(s).parts[0]!).at(-1);
    expect(last('sudo -u root rm -rf /')).toEqual(['rm', '-rf', '/']);
    expect(last('env -i FOO=1 -u BAR rm x')).toEqual(['rm', 'x']);
    expect(last('FOO=1 BAR=2 rm x')).toEqual(['rm', 'x']);
    expect(last('nice -n 5 rm x')).toEqual(['rm', 'x']);
    expect(last('nice -10 rm x')).toEqual(['rm', 'x']);
    expect(last('timeout -s KILL 10s rm x')).toEqual(['rm', 'x']);
    expect(last('nohup time rm x')).toEqual(['rm', 'x']);
    expect(last('xargs -I {} -n 1 rm x')).toEqual(['rm', 'x']);
    expect(last('sudo -- rm x')).toEqual(['rm', 'x']);
    expect(last('busybox rm x')).toEqual(['rm', 'x']);
    expect(last('bash -lc "git push && rm -rf /"')).toEqual(['rm', '-rf', '/']);
    expect(last('sh -c')).toEqual(['sh', '-c']);
    expect(last('cmd.exe /c del x')).toEqual(['del', 'x']);
    expect(last('powershell -Command Remove-Item x')).toEqual(['Remove-Item', 'x']);
    expect(last('env -S "rm -rf x"')).toEqual(['rm', '-rf', 'x']);
    expect(last('env --split-string=rm y')).toEqual(['rm', 'y']);
    expect(last('env -S')).toEqual(['env', '-S']);
    expect(last('eval rm -rf x')).toEqual(['rm', '-rf', 'x']);
    const problems: string[] = [];
    lookThrough(['pwsh', '-EncodedCommand', 'AAAA'], problems);
    expect(problems).toContain('encoded command');
    expect(lookThrough([])).toEqual([[]]);
  });

  it('names and classifies programs', () => {
    expect(programName('/usr/bin/git')).toBe('git');
    expect(programName('C:\\Tools\\git.EXE')).toBe('git');
    expect(classifyProgram(['bash'])).toBe('shell');
    expect(classifyProgram(['pwsh'])).toBe('shell');
    expect(classifyProgram(['cmd'])).toBe('shell');
    expect(classifyProgram(['python3.12', '-c', 'x'])).toBe('interpreter');
    expect(classifyProgram(['node'])).toBe('interpreter');
    expect(classifyProgram(['git'])).toBe('program');
    expect(classifyProgram([])).toBe('program');
  });
});

describe('rule matching (docs/12 §3.1)', () => {
  const gitRead = rule({ pattern: ['git', ['status', 'diff', 'log', 'show']], decision: 'allow' });
  const noRm = rule({ pattern: ['rm', ['-r', '-rf', '-fr', '-R']], decision: 'deny' });

  it('matches allow rules only on every part of a certain command, without wrappers', () => {
    expect(commandMatchesRule(gitRead, 'git status')).toBe(true);
    expect(commandMatchesRule(gitRead, 'git diff --stat HEAD~1')).toBe(true);
    expect(commandMatchesRule(gitRead, 'git status && git log')).toBe(true);
    expect(commandMatchesRule(gitRead, 'git status && curl x')).toBe(false);
    expect(commandMatchesRule(gitRead, 'git push origin main')).toBe(false);
    expect(commandMatchesRule(gitRead, 'gitk')).toBe(false);
    expect(commandMatchesRule(gitRead, 'git')).toBe(false);
    expect(commandMatchesRule(gitRead, 'sudo git status')).toBe(false);
    expect(commandMatchesRule(gitRead, 'GIT_DIR=/x git status')).toBe(false);
    expect(commandMatchesRule(gitRead, 'git status $(rm -rf /)')).toBe(false);
    expect(commandMatchesRule(gitRead, '')).toBe(false);
    expect(commandMatchesRule(gitRead, ['git', 'status'])).toBe(true);
    const bashC = rule({ pattern: ['bash', '-c'], decision: 'allow' });
    expect(commandMatchesRule(bashC, "bash -c 'ls'")).toBe(true);
    expect(commandMatchesRule(bashC, "bash -c 'echo $(id)'")).toBe(false);
  });

  it('matches a path as the command only through hostExecutables for allow rules', () => {
    expect(commandMatchesRule(gitRead, '/usr/bin/git status')).toBe(false);
    const pinned = { ...gitRead, hostExecutables: ['/usr/bin/git'] };
    expect(commandMatchesRule(pinned, '/usr/bin/git status')).toBe(true);
    expect(commandMatchesRule(pinned, '/tmp/git status')).toBe(false);
    expect(prefixMatchesRaw([], ['x'])).toBe(false);
  });

  it('matches deny and ask rules on any part, through wrappers and paths', () => {
    expect(commandMatchesRule(noRm, 'rm -rf build')).toBe(true);
    expect(commandMatchesRule(noRm, 'ls && sudo /bin/rm -rf /')).toBe(true);
    expect(commandMatchesRule(noRm, 'bash -c "cd x; rm -r y"')).toBe(true);
    expect(commandMatchesRule(noRm, 'RM.exe -R x')).toBe(true);
    expect(commandMatchesRule(noRm, 'rm build/app.o')).toBe(false);
    expect(commandMatchesRule(noRm, 'rmdir build')).toBe(false);
    const alt = rule({ pattern: [['curl', 'wget']], decision: 'ask' });
    expect(commandMatchesRule(alt, 'npm test && /usr/bin/wget x')).toBe(true);
    expect(commandMatchesRule(alt, 'ls')).toBe(false);
  });

  it('checks a rule and its examples at load', () => {
    const good = rule({
      pattern: ['git', ['status', 'diff']],
      decision: 'allow',
      matchExamples: ['git status', ['git', 'diff', '--stat']],
      notMatchExamples: ['git push', 'sudo git status'],
    });
    expect(checkCommandRule(good)).toBeNull();
    expect(checkCommandRule({ ...good, matchExamples: ['git push'] })).toMatchObject({
      kind: 'example',
      example: 'git push',
      expected: 'match',
    });
    expect(checkCommandRule({ ...good, notMatchExamples: [['git', 'status']] })).toMatchObject({
      kind: 'example',
      example: 'git status',
      expected: 'no_match',
    });
    expect(checkCommandRule({ ...good, pattern: [] })?.kind).toBe('pattern');
    expect(checkCommandRule({ ...good, pattern: [['status']] })?.kind).toBe('pattern');
    expect(checkCommandRule({ ...good, pattern: [['a', 'a']] })?.kind).toBe('pattern');
    expect(checkCommandRule({ ...good, pattern: ['git status'] })?.kind).toBe('pattern');
    expect(checkCommandRule({ ...good, pattern: [''] })?.kind).toBe('pattern');
    expect(checkCommandRule({ ...good, notMatchExamples: [] })?.kind).toBe('pattern');
  });

  it('rejects a whole rule set when one example fails', () => {
    const ok = rule({
      id: 'ok',
      pattern: ['ls'],
      decision: 'allow',
      matchExamples: ['ls -la'],
      notMatchExamples: ['lsof'],
    });
    const bad = rule({
      id: 'bad',
      pattern: ['rm'],
      decision: 'deny',
      matchExamples: ['rmdir x'],
      notMatchExamples: ['ls'],
    });
    expect(loadCommandRules([ok])).toEqual({ ok: true, rules: [ok] });
    expect(loadCommandRules([ok, bad])).toMatchObject({
      ok: false,
      ruleId: 'bad',
      problem: { example: 'rmdir x' },
    });
  });

  it('covers commands with a grant prefix', () => {
    expect(commandCoveredBy(['npm', 'test'], 'npm test -- --watch')).toBe(true);
    expect(commandCoveredBy(['npm', 'test'], 'npm test && curl x')).toBe(false);
  });
});

describe('evaluateCommand', () => {
  const allowNpm = rule({
    id: 'npm',
    pattern: ['npm', 'test'],
    decision: 'allow',
    justification: 'Tests are safe.',
  });
  const askGit = rule({ id: 'git', pattern: ['git', 'push'], decision: 'ask' });
  const denyRm = rule({ id: 'rm', pattern: ['rm', '-rf'], decision: 'deny' });

  it('combines parts: any deny denies, any ask asks, all allowed allows', () => {
    expect(evaluateCommand('npm test', [allowNpm])).toMatchObject({
      decision: 'allow',
      ruleId: 'npm',
      reason: 'Tests are safe.',
      program: 'program',
      certain: true,
    });
    expect(evaluateCommand('npm test && git push', [allowNpm, askGit])).toMatchObject({
      decision: 'ask',
      ruleId: 'git',
    });
    expect(evaluateCommand('npm test && rm -rf x', [allowNpm, askGit, denyRm])).toMatchObject({
      decision: 'deny',
      reason: 'a command rule denies this command',
    });
    expect(evaluateCommand('git push', [askGit]).reason).toBe(
      'a command rule asks before this command',
    );
    expect(
      evaluateCommand('npm test', [rule({ id: 'n2', pattern: ['npm'], decision: 'allow' })]).reason,
    ).toBe('allowed by a command rule');
  });

  it('explains why nothing decided', () => {
    expect(evaluateCommand('npm test && curl x', [allowNpm])).toMatchObject({
      decision: null,
      reason: '"curl x" is not covered by a command rule',
    });
    expect(evaluateCommand('ls', [allowNpm]).reason).toBe('no command rule covers this command');
    expect(evaluateCommand('npm test $(id)', [allowNpm])).toMatchObject({
      decision: null,
      certain: false,
    });
    expect(evaluateCommand('npm test $(id)', [allowNpm]).reason).toContain('command substitution');
    expect(evaluateCommand('bash -c "eval x"', [allowNpm]).certain).toBe(false);
    expect(evaluateCommand('npm test', [{ ...allowNpm, enabled: false }]).decision).toBeNull();
  });

  it('still applies deny and ask rules to uncertain commands', () => {
    expect(evaluateCommand('echo $(id); rm -rf /', [denyRm]).decision).toBe('deny');
    expect(evaluateCommand('bash -c "git push"', [askGit]).decision).toBe('ask');
  });
});

describe('suggestPrefixRule', () => {
  it('suggests the leading plain words with a match and a non-match example', () => {
    expect(suggestPrefixRule('npm test')).toEqual({
      pattern: ['npm', 'test'],
      matchExamples: ['npm test'],
      notMatchExamples: ['npm install'],
    });
    expect(suggestPrefixRule('npm run migrate -- --env staging')?.pattern).toEqual([
      'npm',
      'run',
      'migrate',
    ]);
    expect(suggestPrefixRule('npm install lodash')?.notMatchExamples).toEqual(['npm push']);
    expect(suggestPrefixRule('ls -la')).toMatchObject({
      pattern: ['ls'],
      notMatchExamples: ['sudo ls'],
    });
    expect(suggestPrefixRule('cat /etc/hosts')?.pattern).toEqual(['cat']);
    expect(suggestPrefixRule('python -m pytest -q')?.pattern).toEqual(['python', '-m', 'pytest']);
    expect(suggestPrefixRule('python manage.py migrate')?.pattern).toEqual(['python', 'manage.py']);
  });

  it('suggests nothing when no safe prefix exists', () => {
    for (const cmd of [
      'npm test && curl x',
      'echo $(id)',
      'sudo npm test',
      'FOO=1 npm test',
      './run.sh',
      'bash -c "ls"',
      'python -c "print(1)"',
      'python',
      'eval ls',
      '',
    ])
      expect(suggestPrefixRule(cmd), cmd).toBeNull();
  });

  it('always produces a rule whose own examples pass', () => {
    for (const cmd of [
      'npm test',
      'git status --short',
      'ls',
      'cargo run --release',
      'python -m http.server',
    ]) {
      const s = suggestPrefixRule(cmd)!;
      expect(checkCommandRule({ ...s, decision: 'allow' }), cmd).toBeNull();
    }
  });
});
