// First-run setup as a conversation (PROFILES-AND-CUSTOMIZATION): Nova asks, proposes a default,
// and writes each answer to the profile as it goes, the same records a settings screen would.
// It is a scripted interview, not a model: setup has to work before any model is configured,
// and with the network cable pulled. Anything can be skipped; the default stays.
import { EventEmitter } from 'node:events';
import { CoreError } from './errors.ts';
import { DEFAULTS, identityOf } from './identity.ts';
import type { PrivacyMode } from './envelope.ts';
import type { Egress } from './workers.ts';
import type { Ledger, Task } from './ledger.ts';
import type { Profile } from './profile.ts';

// What capture can and can't do on each kind of device, said once in setup (M6a; Settings › Capture
// says it in full). Capture starts off, whatever the answers above.
export const CAPTURE_NOTE = 'Capture is off until you turn a source on in Settings › Capture. A computer can share a lot, under its own permissions; Android needs accessibility and notification access; an iPhone or iPad allows no passive capture of other apps at all.';

export const STEPS = ['user_name', 'timezone', 'nova_name', 'directness', 'privacy', 'first_task', 'done'] as const;
export type Step = (typeof STEPS)[number];

export interface Turn { from: 'nova' | 'person'; text: string; at: string }
export interface SetupState { step: Step; transcript: Turn[]; first_task: string | null }
export interface SetupView extends SetupState { done: boolean; question: string | null }

const MAX_TURNS = 400;
const YES = /^(y|yes|yeah|yep|sure|ok(ay)?|correct|right|that['’]?s right|please|go( ahead)?|do it)\b/i;
const NO = /^(n|no|nope|nah|not now|no thanks?|skip)\b/i;
const SKIP = /^(skip|pass|next|whatever|don['’]?t care|you (pick|choose)|default)\b/i;

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
  'local-only': 'my model calls stay on your devices',
  'local-preferred': 'local first, cloud only when local can’t do it, and each cloud call is recorded',
  'cloud-allowed': 'I may use cloud models when they’re the better tool, within your budget',
};

export class Setup extends EventEmitter {
  #profile: Profile;
  #ledger: Ledger;
  #now: () => Date;
  #detectedTz: string;
  #chat: { program: string; egress: Egress } | null;

  constructor(o: { profile: Profile; ledger: Ledger; now?: () => Date; detectedTimezone?: string; chat?: { program: string; egress: Egress } }) {
    super();
    this.#profile = o.profile;
    this.#ledger = o.ledger;
    this.#now = o.now ?? (() => new Date());
    this.#detectedTz = o.detectedTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.#chat = o.chat ?? null;
  }

  // Reading never writes: before the first answer, the opening question is shown, not stored.
  view(): SetupView {
    const s = this.#state();
    if (!s.transcript.length) s.transcript.push(this.#turn('nova', this.#ask(s.step)));
    return { ...s, done: s.step === 'done', question: s.step === 'done' ? null : this.#ask(s.step) };
  }

  // One message from the person; Nova's reply ends with the next question, if there is one.
  answer(input: string): { reply: string; view: SetupView; task: Task | null } {
    const text = typeof input === 'string' ? input.trim() : '';
    if (!text) throw new CoreError('validation', 'Say something, even "skip".');
    if (text.length > 2000) throw new CoreError('validation', 'That’s longer than any setup answer needs to be.');
    const s = this.#state();
    if (!s.transcript.length) s.transcript.push(this.#turn('nova', this.#ask(s.step)));
    if (s.step === 'done') throw new CoreError('conflict', 'Setup is already finished. You can change most of it in Settings.');
    s.transcript.push(this.#turn('person', text));

    const { reply, next, task } = this.#handle(s.step, text);
    s.step = next;
    if (task) s.first_task = task.id;
    s.transcript.push(this.#turn('nova', reply));
    this.#save(s);
    const view = this.view();
    this.emit('change', view);
    return { reply, view, task: task ?? null };
  }

  #handle(step: Step, text: string): { reply: string; next: Step; task?: Task } {
    const skip = SKIP.test(text);
    const set = (section: 'identity' | 'user' | 'tuning' | 'privacy', key: string, value: unknown) => this.#profile.set(section, key, value, 'setup');
    const then = (lead: string, next: Step) => ({ reply: `${lead}\n\n${this.#ask(next)}`, next });

    switch (step) {
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
        return then(`Got it: ${PRIVACY_WORDS[p]}.`, 'first_task');
      }
      case 'first_task': {
        if (NO.test(text)) return { reply: this.#closing('No first task, then.'), next: 'done' };
        if (!YES.test(text)) return { reply: 'Yes or no: shall I write the welcome note?', next: step };
        const task = this.#firstTask();
        return { reply: this.#closing('Started. It’s in Tasks.'), next: 'done', task };
      }
      case 'done':
        throw new CoreError('conflict', 'Setup is already finished.');
    }
  }

  #ask(step: Step): string {
    const me = identityOf(this.#profile);
    switch (step) {
      case 'user_name':
        return `Hi, I’m ${me.name}. A few quick questions to set things up; you can change most answers later in Settings, and "skip" keeps my default.\n\nWhat should I call you?`;
      case 'timezone':
        return `Your computer says you’re on ${this.#detectedTz} time. Is that right? (Yes, or tell me the right one.)`;
      case 'nova_name':
        return `I go by ${me.name}. Want to call me something else? (A name, or "keep".)`;
      case 'directness':
        return 'How direct should I be? Telling you when I think something’s wrong isn’t adjustable. But I can say it gently, plainly, or bluntly.';
      case 'privacy': {
        // Truthful about the one thing that would leave: the chat model, if it's a cloud one.
        const chat = this.#chat?.egress === 'remote'
          ? ` One thing to know: chat is set up to use ${this.#chat.program}, which runs in the cloud. With local-only, chat stays off until you add a local model.`
          : '';
        return `Last setting: privacy. Local-only means my model calls stay on your own devices.${chat} I’d keep it local unless you want cloud help when local isn’t enough. Keep it local-only, or allow cloud when needed?`;
      }
      case 'first_task':
        return `${this.#summary()}\n\nWant a first task to prove the plumbing works? I’ll write a short welcome note into your workspace. (Yes or no.)`;
      case 'done':
        return '';
    }
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
    return `${lead} That’s setup done. ${CAPTURE_NOTE} Ask me anything; you can change most of this in Settings.`;
  }

  #firstTask(): Task {
    const me = identityOf(this.#profile);
    const content = `# Welcome\n\n${me.user_name ? `Hello, ${me.user_name}.` : 'Hello.'} This note was written by ${me.name}'s workspace worker during setup, as a first task.\n\nYour settings: ${this.#summary().replace(/^Here’s what I have: /, '')}\n`;
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
    return s && STEPS.includes(s.step) ? s : { step: 'user_name', transcript: [], first_task: null };
  }

  #save(s: SetupState): void {
    this.#profile.set('setup', 'state', { ...s, transcript: s.transcript.slice(-MAX_TURNS) }, 'setup');
  }

  #turn(from: Turn['from'], text: string): Turn {
    return { from, text, at: this.#now().toISOString() };
  }
}
