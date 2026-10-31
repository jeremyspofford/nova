// First-run setup as a conversation (PROFILES-AND-CUSTOMIZATION): Nova asks, proposes a default,
// and writes each answer to the profile as it goes, the same records a settings screen would.
// It is a scripted interview, not a model: setup has to work before any model is configured,
// and with the network cable pulled. Anything can be skipped; the default stays.
//
// Onboarding (M10f, docs/plans/M10f.md §3; the orchestration ADR, Point 11; Amendment 2026-10-31-B
// Part 2) is the same conversation, in the ADR's order: detect this device, create or join a
// network with this hub's roles, the backend for this OS; then the person; then, only if they ask,
// discovery and a consent-first import; then the first task. It ends on a populated first view.
import { EventEmitter } from 'node:events';
import { CoreError } from './errors.ts';
import { DEFAULTS, identityOf } from './identity.ts';
import { checkPurposes, fixedPurposes, PURPOSE_WORDS, purposeWords, type Purpose } from './mesh/purposes.ts';
import { backendFor, SUPERVISOR_WORDS } from './onboard/backend.ts';
import { detectOs, factsFrom, factsWords, recommendedHubPurposes, type DeviceFacts, type OsFamily } from './onboard/detect.ts';
import type { Discovery } from './onboard/discover.ts';
import { firstAction, type FirstView } from './onboard/first.ts';
import { mentionsDevice, readPicks, readScope } from './onboard/consent.ts';
import type { Imported, Source } from './onboard/sources.ts';
import type { Hardware } from './models/hardware.ts';
import type { PrivacyMode } from './envelope.ts';
import type { Egress } from './workers.ts';
import type { Ledger, Task } from './ledger.ts';
import type { Profile } from './profile.ts';

// What capture can and can't do on each kind of device, said once in setup (M6a; Settings › Capture
// says it in full). Capture starts off, whatever the answers above.
export const CAPTURE_NOTE = 'I see nothing on your devices unless you turn capture on in Settings › Capture. A computer can share a lot, under its own permissions; Android needs accessibility and notification access; an iPhone or iPad allows no passive capture of other apps at all.';

export const STEPS = ['device', 'roles', 'backend', 'user_name', 'timezone', 'nova_name', 'directness', 'privacy', 'discover', 'import', 'first_task', 'done'] as const;
export type Step = (typeof STEPS)[number];

export interface Turn { from: 'nova' | 'person'; text: string; at: string }
// What onboarding settled, kept with the conversation.
export interface Onboarded {
  facts?: DeviceFacts;
  network?: 'new';
  backend?: 'supervisor';
  discovery?: Discovery | null;
  // Under local-only, a network yes waits here until the warning is acknowledged.
  network_pending?: boolean;
  sources?: Source[];
  imported?: Imported[];
}
export interface SetupState { step: Step; transcript: Turn[]; first_task: string | null; onboarding?: Onboarded }
// A question with set answers, so a screen can offer them as choices. The answer is still text,
// sent as `submit` says: the labels picked, joined.
export interface Choice { id: string; label: string; note: string; selected: boolean; locked?: boolean; available?: boolean }
export interface Options { kind: 'one' | 'many'; choices: Choice[] }
export interface SetupView extends SetupState { done: boolean; question: string | null; options: Options | null; first: FirstView | null }

// What setup needs from the rest of Nova for the device steps. Each has a quiet default, so setup
// works alone (and in its own tests) without reading the machine's network or files.
export interface Onboarding {
  os(): OsFamily;
  hardware(): Promise<Hardware | null>;
  hubPurposes(): Purpose[];
  // The person's explicit choice, on the hub's own screen: that is the tier-3 confirmation.
  setHubPurposes(p: Purpose[]): Purpose[];
  discover(scope: 'device' | 'network'): Promise<Discovery>;
  sources(): Source[];
  import(picked: Source[]): Promise<Imported[]>;
}

export function quietOnboarding(o: { os?: OsFamily } = {}): Onboarding {
  let mine = fixedPurposes('computer', { hub: true });
  return {
    os: () => o.os ?? detectOs(),
    hardware: async () => null,
    hubPurposes: () => mine,
    setHubPurposes: (p) => (mine = checkPurposes(p, 'computer', { hub: true })),
    discover: async (scope) => ({ scope, found: [], looked: [], transport: 'none', bound: null, at: new Date().toISOString() }),
    sources: () => [],
    import: async () => [],
  };
}

const MAX_TURNS = 400;
const YES = /^(y|yes|yeah|yep|sure|ok(ay)?|correct|right|that['’]?s right|please|go( ahead)?|do it)\b/i;
const NO = /^(n|no|nope|nah|not now|no thanks?|skip)\b/i;
const SKIP = /^(skip|pass|next|whatever|don['’]?t care|you (pick|choose)|default)\b/i;

// What a hub may be for besides being the hub, as the roles step offers it.
const HUB_CHOICES: Purpose[] = ['compute', 'storage', 'capture-source', 'general-server'];
const PURPOSE_HINTS: [Purpose, RegExp][] = [
  ['compute', /\b(compute|models?|gpu|inference|heavy)\b/i],
  ['storage', /\b(storage|store|data|disk)\b/i],
  ['capture-source', /\bcapture/i],
  ['general-server', /\b(general|server|services?)\b/i],
];

const clean = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '');

// "call me Sam", "I'm Sam", "my name is Sam." → "Sam"
export function nameFrom(text: string): string | null {
  const t = clean(text)
    .replace(/^(hi|hello|hey|hiya|howdy|good (morning|afternoon|evening))( there)?\b[!,.]*\s*/i, '')
    .replace(/^(you can |please )?(call me|i['’]?m|i am|it['’]?s|my name is|name['’]?s|this is)\s+/i, '')
    .replace(/[!.,]+$/, '');
  return t && t.length <= 40 && !/[<>{}\n]/.test(t) ? t : null;
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return /\//.test(tz) || tz === 'UTC';
  } catch {
    return false;
  }
}

function directnessFrom(text: string): 'gentle' | 'balanced' | 'blunt' | null {
  const t = text.toLowerCase();
  if (/gentl|soft|kind|easy/.test(t)) return 'gentle';
  if (/blunt|harsh|brutal|very direct|no filter|straight/.test(t)) return 'blunt';
  if (/plain|balanc|normal|middle|medium|direct/.test(t)) return 'balanced';
  return null;
}

// Saying no to the cloud must never turn it on, so refusals and local answers are read first.
export function privacyFrom(text: string): PrivacyMode | null {
  const t = text.toLowerCase().replace(/’/g, "'");
  if (/\b(no|not|never|don['’]?t|do not|without|nothing (in|to|on)( the)?)\b[^.]*\bcloud/.test(t) || /\bcloud\b[^.]*\b(no|never|not)\b/.test(t)) return 'local-only';
  if (/local[- ]?only|^(keep|stay)|keep (it|everything)|stay local|private|this machine|^yes\b/.test(t)) return 'local-only';
  if (/always.*cloud|cloud.*(always|freely|any ?time|whenever)|cloud[- ]allowed/.test(t)) return 'cloud-allowed';
  if (/allow|when (it['’]?s )?needed|fallback|fall back|if needed|local[- ]preferred|\bcloud\b/.test(t)) return 'local-preferred';
  if (/\blocal\b/.test(t)) return 'local-only';
  return null;
}

const PRIVACY_WORDS: Record<PrivacyMode, string> = {
  'local-only': 'everything stays on your devices',
  'local-preferred': 'local first, cloud only when local can’t do it, and I’ll always say when',
  'cloud-allowed': 'I may use cloud models when they’re the better tool, within your budget',
};

const IMPORT_FOLDER = 'You can put notes or exports in ~/workspace/import/ any time, and tell me.';

export class Setup extends EventEmitter {
  #profile: Profile;
  #ledger: Ledger;
  #now: () => Date;
  #detectedTz: string;
  #chat: { program: string; egress: Egress } | null;
  #on: Onboarding;
  #facts: DeviceFacts | null = null;
  // One answer at a time: discovery and import take a moment, and answers wait their turn.
  #turns: Promise<unknown> = Promise.resolve();

  constructor(o: { profile: Profile; ledger: Ledger; now?: () => Date; detectedTimezone?: string; chat?: { program: string; egress: Egress }; onboarding?: Onboarding }) {
    super();
    this.#profile = o.profile;
    this.#ledger = o.ledger;
    this.#now = o.now ?? (() => new Date());
    this.#detectedTz = o.detectedTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.#chat = o.chat ?? null;
    this.#on = o.onboarding ?? quietOnboarding();
  }

  // Reads this device's hardware once, so the first question can say what it is. Setup works
  // without it: until then, or if it fails, it says what Node knows.
  async ready(): Promise<void> {
    if (this.#facts) return;
    const hw = await this.#on.hardware().catch(() => null);
    this.#facts = factsFrom(this.#on.os(), hw);
  }

  #deviceFacts(s?: SetupState): DeviceFacts {
    return s?.onboarding?.facts ?? this.#facts ?? factsFrom(this.#on.os(), null);
  }

  // Whether setup is finished, without building the view.
  done(): boolean {
    return this.#state().step === 'done';
  }

  // Reading never writes: before the first answer, the opening question is shown, not stored.
  view(): SetupView {
    const s = this.#state();
    if (!s.transcript.length) s.transcript.push(this.#turn('nova', this.#ask(s.step, s)));
    const done = s.step === 'done';
    return { ...s, done, question: done ? null : this.#ask(s.step, s), options: done ? null : this.#options(s.step, s), first: done ? this.#first(s) : null };
  }

  // One message from the person; Nova's reply ends with the next question, if there is one.
  answer(input: string): Promise<{ reply: string; view: SetupView; task: Task | null }> {
    const run = this.#turns.then(() => this.#answer(input));
    this.#turns = run.catch(() => {});
    return run;
  }

  async #answer(input: string): Promise<{ reply: string; view: SetupView; task: Task | null }> {
    const text = typeof input === 'string' ? input.trim() : '';
    if (!text) throw new CoreError('validation', 'Say something, even "skip".');
    if (text.length > 2000) throw new CoreError('validation', 'That’s longer than any setup answer needs to be.');
    await this.ready();
    const s = this.#state();
    if (!s.transcript.length) s.transcript.push(this.#turn('nova', this.#ask(s.step, s)));
    if (s.step === 'done') throw new CoreError('conflict', 'Setup is already finished. You can change anything by telling me.');
    s.transcript.push(this.#turn('person', text));

    const { reply, next, task } = await this.#handle(s.step, text, s);
    s.step = next;
    if (task) s.first_task = task.id;
    s.transcript.push(this.#turn('nova', reply));
    this.#save(s);
    const view = this.view();
    this.emit('change', view);
    return { reply, view, task: task ?? null };
  }

  async #handle(step: Step, text: string, s: SetupState): Promise<{ reply: string; next: Step; task?: Task }> {
    const skip = SKIP.test(text);
    const set = (section: 'identity' | 'user' | 'tuning' | 'privacy', key: string, value: unknown) => this.#profile.set(section, key, value, 'setup');
    const then = (lead: string, next: Step) => ({ reply: `${lead}\n\n${this.#ask(next, s)}`, next });
    const on = (s.onboarding ??= {});

    switch (step) {
      case 'device': {
        if (/\b(join|existing|already (have|got)|another (hub|nova)|other (hub|nova))\b/i.test(text)) {
          return { reply: 'To join a Nova you already have, this computer joins as one of its devices instead: on that hub, open Settings › Devices › Add a device, and run the command it shows here. This Nova isn’t needed for that; you can close it. Or say “new” to start a network with this computer as its hub.', next: step };
        }
        if (!(skip || YES.test(text) || /\b(new|create|start|here|this one|this computer|hub)\b/i.test(text))) return { reply: 'A new network with this computer as its hub, or join one you already have? (New, or join.)', next: step };
        on.facts = this.#deviceFacts(s);
        on.network = 'new';
        return then('This computer is your hub, then. Other devices join it from Settings › Devices.', 'roles');
      }
      case 'roles': {
        const recommended = recommendedHubPurposes(this.#deviceFacts(s));
        let picked: Purpose[];
        if (skip || YES.test(text) || /\b(recommend|keep|fine)/i.test(text)) picked = recommended;
        else if (/^(none|nothing( else)?|just (the )?hub|only (the )?hub|no)\b/i.test(text)) picked = fixedPurposes('computer', { hub: true });
        else {
          picked = PURPOSE_HINTS.filter(([, re]) => re.test(text)).map(([p]) => p);
          if (!picked.length) return { reply: `Which of these is this computer for: ${HUB_CHOICES.map((p) => PURPOSE_WORDS[p].label.toLowerCase()).join(', ')}? Or “yes” for what I recommend (${purposeWords(recommended.filter((p) => p !== 'hub-candidate')).toLowerCase()}).`, next: step };
        }
        const mine = this.#on.setHubPurposes(checkPurposes(picked, 'computer', { hub: true }));
        return then(`This hub is for: ${purposeWords(mine.filter((p) => p !== 'hub-candidate')).toLowerCase()}. You can change that in Settings › Devices.`, 'backend');
      }
      case 'backend': {
        const b = backendFor(this.#deviceFacts(s).os);
        on.backend = 'supervisor';
        const asked = /\b(k3s|kubernetes|k8s|cluster|containers?)\b/i.test(text);
        const lead = !asked ? 'Ordinary programs it is.'
          : b.os === 'linux' ? 'K3s isn’t available in this version yet, so Nova uses ordinary programs. When it is, you’ll be able to switch in Settings › Services.'
            : 'K3s needs Linux, so on this computer Nova uses ordinary programs.';
        return then(lead, 'user_name');
      }
      case 'user_name': {
        if (skip) return then('No problem, I’ll manage without a name for now.', 'timezone');
        const name = nameFrom(text);
        if (!name) return { reply: 'I didn’t catch a name there. What should I call you? (Or "skip".)', next: step };
        set('user', 'name', name);
        set('user', 'address_as', name);
        return then(`Nice to meet you, ${name}.`, 'timezone');
      }
      case 'timezone': {
        if (skip || YES.test(text)) {
          set('user', 'timezone', this.#detectedTz);
          return then(`${this.#detectedTz} it is.`, 'nova_name');
        }
        // "no, it's Europe/Paris" → Europe/Paris; a bare city like "new york" → New_York.
        const said = clean(text).replace(/^(no|nope|nah)\b[,.]?\s*/i, '').replace(/^(it['’]?s|i['’]?m (in|on))\s+/i, '');
        const tz = (/[A-Za-z_]+\/[A-Za-z_/]+/.exec(said)?.[0] ?? said).replace(/\s+/g, '_').toLowerCase();
        const zones = Intl.supportedValuesOf('timeZone');
        const match = zones.find((z) => z.toLowerCase() === tz) ?? zones.find((z) => z.toLowerCase().endsWith(`/${tz}`));
        if (!match || !validTimezone(match)) return { reply: 'I don’t know that timezone. Try a name like America/Chicago or Europe/Paris, or say "yes" to keep ' + this.#detectedTz + '.', next: step };
        set('user', 'timezone', match);
        return then(`${match} it is.`, 'nova_name');
      }
      case 'nova_name': {
        if (skip || NO.test(text) || /^(keep( it)?|nova|fine|that['’]?s fine|it['’]?s fine)$/i.test(clean(text))) {
          set('identity', 'name', DEFAULTS.name);
          return then(`${DEFAULTS.name} it stays.`, 'directness');
        }
        const name = nameFrom(text.replace(/^(call you|you can be|how about)\s+/i, ''));
        if (!name || name.length > 30) return { reply: 'Give me a short name, or say "keep".', next: step };
        set('identity', 'name', name);
        return then(`${name} it is. Everything else about me stays the same; only the name changes.`, 'directness');
      }
      case 'directness': {
        const d = skip ? 'balanced' : directnessFrom(text);
        if (!d) return { reply: 'Gently, plainly, or bluntly?', next: step };
        set('tuning', 'directness', d);
        return then(d === 'blunt' ? 'Blunt it is.' : d === 'gentle' ? 'Gently, then. Still honest.' : 'Plainly, then.', 'privacy');
      }
      case 'privacy': {
        const p = skip ? 'local-only' : privacyFrom(text);
        if (!p) return { reply: 'Keep it local-only, or allow cloud help when local isn’t enough?', next: step };
        set('privacy', 'default', p);
        return then(`Got it: ${PRIVACY_WORDS[p]}.`, 'discover');
      }
      case 'discover': {
        // Discovery runs only when the person asks (the smart-home ADR §6), and consent fails closed
        // (onboard/consent.ts): only an unambiguous yes looks, and only where it says.
        let scope = readScope(text);
        if (on.network_pending) {
          // The warning was shown: a plain yes now acknowledges it; naming this computer keeps it here.
          if (scope === 'device' && !mentionsDevice(text)) scope = 'network';
        } else if (scope === 'network' && this.#profile.privacyDefault() === 'local-only') {
          on.network_pending = true;
          return { reply: this.#ask('discover', s), next: step };
        }
        if (scope === 'unclear') return { reply: on.network_pending ? 'Look on the network, this computer only, or no?' : 'This computer only, the network too, or no?', next: step };
        on.network_pending = false;
        if (scope === 'none') {
          on.discovery = null;
          return then(`No looking, then. ${IMPORT_FOLDER}`, 'first_task');
        }
        const network = scope === 'network';
        const d = await this.#on.discover(network ? 'network' : 'device');
        on.discovery = d;
        on.sources = this.#on.sources();
        const lead = this.#foundWords(d);
        return on.sources.length ? then(lead, 'import') : then(`${lead} I didn’t find notes, calendar files or browser bookmarks I could bring in. ${IMPORT_FOLDER}`, 'first_task');
      }
      case 'import': {
        const sources = on.sources ?? [];
        // Only what is said yes to is read (onboard/consent.ts); anything unclear asks again.
        const read = readPicks(text, sources);
        if (read.kind === 'unclear') return { reply: `Which of these, if any: ${sources.map((x) => x.label).join('; ')}? (Say which, “all”, or “none”.)`, next: step };
        const picked: Source[] = read.kind === 'none' ? [] : sources.filter((x) => read.ids.includes(x.id));
        if (!picked.length) { on.imported = []; return then(`Nothing brought in, then. ${IMPORT_FOLDER}`, 'first_task'); }
        const done = await this.#on.import(picked);
        on.imported = done;
        const waiting = done.reduce((n, r) => n + r.waiting, 0);
        const lines = done.map((r) => `${r.label}: ${r.said}`).join(' ');
        return then(`Checked first, then brought in. ${lines}${waiting ? ' It waits in Memory for your OK: none of it is remembered until you keep it.' : ''}`, 'first_task');
      }
      case 'first_task': {
        if (NO.test(text)) return { reply: this.#closing('No first task, then.'), next: 'done' };
        if (!YES.test(text)) return { reply: 'Yes or no: shall I write the welcome note and check it?', next: step };
        const task = this.#firstTask();
        return { reply: this.#closing('Started. I’ll check the note myself before I call it done.'), next: 'done', task };
      }
      case 'done':
        throw new CoreError('conflict', 'Setup is already finished.');
    }
  }

  #foundWords(d: Discovery): string {
    const here = d.found.filter((f) => f.where === 'this computer');
    const there = d.found.filter((f) => f.where === 'your network');
    const list = (xs: Discovery['found']) => xs.map((f) => `${f.name} at ${f.address}`).join('; ');
    const parts = [
      here.length ? `On this computer I found ${list(here)}.` : 'On this computer I found no services Nova knows.',
      ...(d.scope === 'network' ? [there.length ? `On your network: ${list(there)}.` : 'On your network, nothing answered.'] : []),
    ];
    return `${parts.join(' ')}${d.found.length ? ' None of it is connected: that is yours to do, from Settings, when you want.' : ''}`;
  }

  #ask(step: Step, s: SetupState): string {
    const me = identityOf(this.#profile);
    switch (step) {
      case 'device': {
        const f = this.#deviceFacts(s);
        return `Hi, I’m ${me.name}. A few quick questions to set things up; you can change any answer later just by telling me, and "skip" keeps my default. The first three are about this computer, and those you change in Settings › Devices and Settings › Services.\n\nThis is ${factsWords(f)}. I’d make it the hub of a new Nova network: your phone and other computers join it later. Or, if you already have a Nova hub, this computer can join that instead. (New, or join?)`;
      }
      case 'roles': {
        const rec: Purpose[] = recommendedHubPurposes(this.#deviceFacts(s)).filter((p) => p !== 'hub-candidate');
        const note = (p: Purpose) => { const n = PURPOSE_WORDS[p].note.replace(/\.$/, '').replace(/\. /g, '; '); return n.charAt(0).toLowerCase() + n.slice(1); };
        const others = HUB_CHOICES.filter((p) => !rec.includes(p)).map((p) => `${PURPOSE_WORDS[p].label.toLowerCase()} (${note(p)})`);
        return `What is this computer for, besides being the hub? I recommend ${purposeWords(rec).toLowerCase()}${rec.includes('compute') ? ', since its GPU can run models' : ''}. The others: ${others.join('; ')}. (“Yes” for what I recommend, or say which.)`;
      }
      case 'backend': {
        const b = backendFor(this.#deviceFacts(s).os);
        return `How Nova runs its services here. ${b.gets} ${b.misses} ${b.switching} (“Yes” to go on.)`;
      }
      case 'user_name':
        return 'Now about you. What should I call you?';
      case 'timezone':
        return `Your computer says you’re on ${this.#detectedTz} time. Is that right? (Yes, or tell me the right one.)`;
      case 'nova_name':
        return `I go by ${me.name}. Want to call me something else? (A name, or "keep".)`;
      case 'directness':
        return 'How direct should I be? I’ll always tell you when I think something’s wrong; that part isn’t adjustable. But I can say it gently, plainly, or bluntly.';
      case 'privacy': {
        // Truthful about the one thing that would leave: the chat model, if it's a cloud one.
        const chat = this.#chat?.egress === 'remote'
          ? ` One thing to know: chat is set up to use ${this.#chat.program}, which runs in the cloud. With local-only, chat stays off until you add a local model; everything else works.`
          : '';
        return `Last setting: privacy. Local-only means nothing leaves this machine.${chat} I’d keep it local unless you want cloud help when local isn’t enough. Keep it local-only, or allow cloud when needed?`;
      }
      case 'discover': {
        if (s.onboarding?.network_pending) return 'Looking on the network sends one short query to the devices on it, beyond this machine, with nothing about you in it. You chose local-only, so I ask first: go ahead? (Yes, “this computer only”, or no.)';
        // Looking on the network sends a query onto it: under local-only, that is said before asking.
        const local = this.#profile.privacyDefault() === 'local-only' ? ' You chose local-only: looking on the network sends one short query to the devices on it, with nothing about you in it, so say “network too” only if that’s fine.' : '';
        return `Shall I look for things Nova could work with? On this computer: a local model runtime, Screenpipe or Home Assistant, and notes, calendar files or browser bookmarks I could bring in. On your network too: a home hub, and other computers that could join. Looking only finds them: nothing is connected, and nothing is read.${local} (This computer, network too, or no?)`;
      }
      case 'import': {
        const sources = s.onboarding?.sources ?? [];
        const shown = sources.map((x) => `${x.label}${x.kind === 'notes' ? ` (${x.files} file${x.files === 1 ? '' : 's'})` : ''}`).join('; ');
        return `I could bring in, from this computer: ${shown}. Nothing has been read yet. What you pick is checked first as outside content, then waits in Memory for your OK: none of it is remembered until you keep it. Which? (Say which, “all”, or “none”.)`;
      }
      case 'first_task':
        return `${this.#summary()}\n\nWant a first task to prove the plumbing works? I’ll write a short welcome note into your workspace and check it myself. (Yes or no.)`;
      case 'done':
        return '';
    }
  }

  // The set answers a screen can offer for this question; the answer stays text.
  #options(step: Step, s: SetupState): Options | null {
    switch (step) {
      case 'device':
        return { kind: 'one', choices: [
          { id: 'new', label: 'New network, this computer as hub', note: 'Recommended.', selected: true },
          { id: 'join', label: 'Join a hub I already have', note: 'This computer joins as one of its devices.', selected: false },
        ] };
      case 'roles': {
        const rec = recommendedHubPurposes(this.#deviceFacts(s));
        const fixed = fixedPurposes('computer', { hub: true });
        return { kind: 'many', choices: HUB_CHOICES.map((p) => ({ id: p, label: PURPOSE_WORDS[p].label, note: PURPOSE_WORDS[p].note, selected: rec.includes(p), ...(fixed.includes(p) ? { locked: true } : {}) })) };
      }
      case 'backend':
        return { kind: 'one', choices: backendFor(this.#deviceFacts(s).os).options.map((o) => ({ id: o.id, label: o.label, note: o.note, selected: o.recommended, available: o.available })) };
      case 'discover':
        if (s.onboarding?.network_pending) return { kind: 'one', choices: [
          { id: 'network-ok', label: 'Yes, look on the network', note: 'One short query to the devices on it.', selected: false },
          { id: 'device', label: 'This computer only', note: 'Nothing goes onto the network.', selected: true },
          { id: 'no', label: 'No', note: 'Look for nothing.', selected: false },
        ] };
        return { kind: 'one', choices: [
          { id: 'device', label: 'This computer', note: 'Services here, and notes, calendar files or bookmarks.', selected: true },
          { id: 'network', label: 'The network too', note: 'One short query to the devices on it.', selected: false },
          { id: 'no', label: 'No', note: 'Look for nothing.', selected: false },
        ] };
      case 'import':
        return { kind: 'many', choices: (s.onboarding?.sources ?? []).map((x) => ({ id: x.id, label: x.label, note: x.kind === 'notes' ? `${x.files} file${x.files === 1 ? '' : 's'}` : x.kind === 'calendar' ? 'Upcoming and recent events' : 'One memory per folder', selected: true })) };
      default:
        return null;
    }
  }

  // What setup ends on (Amendment 2026-10-31-B Part 2): never a blank chat alone.
  #first(s: SetupState): FirstView {
    const on = s.onboarding ?? {};
    const facts = this.#deviceFacts(s);
    const roles = this.#on.hubPurposes();
    const imported = on.imported ?? [];
    const waiting = imported.reduce((n, r) => n + r.waiting, 0);
    return {
      found: on.discovery?.found ?? [], looked: !!on.discovery, imported, waiting,
      device: { words: factsWords(facts), roles, roles_words: purposeWords(roles.filter((p) => p !== 'hub-candidate')), backend: on.backend ?? 'supervisor', backend_words: SUPERVISOR_WORDS },
      action: firstAction(waiting),
    };
  }

  #summary(): string {
    const me = identityOf(this.#profile);
    const mode = this.#profile.privacyDefault();
    const parts = [
      me.user_name ? `I’ll call you ${me.user_name}` : 'no name for you yet',
      me.timezone ?? this.#detectedTz,
      `I’m ${me.name}`,
      `${me.directness === 'balanced' ? 'plain' : me.directness} about hard truths`,
      mode,
    ];
    return `Here’s what I have: ${parts.join('; ')}.`;
  }

  #closing(lead: string): string {
    return `${lead} That’s setup done. ${CAPTURE_NOTE} Ask me anything, or tell me to change any of this.`;
  }

  #firstTask(): Task {
    const me = identityOf(this.#profile);
    const content = `# Welcome\n\n${me.user_name ? `Hello, ${me.user_name}.` : 'Hello.'} This note was written by ${me.name}'s workspace worker during setup, then read back and checked before the task was marked done.\n\nYour settings: ${this.#summary().replace(/^Here’s what I have: /, '')}\n`;
    return this.#ledger.create({
      title: 'Write a welcome note',
      owner: 'workspace',
      goal: 'A welcome note is in the workspace, and its contents are verified.',
      origin: { kind: 'setup' },
      privacy_mode: this.#profile.privacyDefault(),
      approval_tier: 1,
      evidence_required: [{ kind: 'read_back', target: 'workspace:welcome.md' }],
      inputs: { action: 'write', path: 'welcome.md', content },
      idempotency_key: 'setup:first-task',
    });
  }

  #state(): SetupState {
    const s = this.#profile.get<SetupState>('setup', 'state');
    return s && STEPS.includes(s.step) ? s : { step: 'device', transcript: [], first_task: null };
  }

  #save(s: SetupState): void {
    this.#profile.set('setup', 'state', { ...s, transcript: s.transcript.slice(-MAX_TURNS) }, 'setup');
  }

  #turn(from: Turn['from'], text: string): Turn {
    return { from, text, at: this.#now().toISOString() };
  }
}
