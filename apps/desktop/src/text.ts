// The desktop shell's words (FR-016): the tray, menus, notifications, dialogs, the status list,
// connect and capture messages, local model errors and the shell's own pages (connect, quick chat,
// attach preview). Every function reads its messages when it runs, so a locale change applies to
// the next menu, notification or page text.
import { defineMessages } from '@nova/i18n';

export const SHELL_TEXT = defineMessages('desktop.shell', {
  windows: {
    connect: 'Connect to your Hub',
    quick: 'Quick chat',
    attach: 'Attach window',
  },
  signInFirst: 'Sign in to Nova first: open Nova and sign in.',
  invalidRequest: 'That request was not valid.',
  distrust: 'Nova did not trust the Hub',
  attachWindow: 'Attach window',
  novaInFront:
    'A Nova window is in front. Bring the window you want to attach to the front, then press the shortcut again.',
  notAllowed: 'Not allowed from this page.',
  notConnected: 'Not connected to a Hub.',
  notAPlace: 'That is not a place in Nova.',
  captureExpired: 'This capture has expired. Capture the window again.',
  tooManyLocal: 'Four local answers are already running.',
});

export const MENU_TEXT = defineMessages('desktop.menu', {
  file: 'File',
  quickChat: 'Quick chat',
  newTask: 'New task',
  newWindow: 'New window',
  attachWindow: 'Attach window',
  changeHub: 'Change Hub…',
  openNova: 'Open Nova',
  quitNova: 'Quit Nova',
  notConnected: 'Not connected to a Hub',
  nothingWaiting: 'Nothing waiting',
  signInToSee: 'Sign in to see your work',
});

export const STATUS_TEXT = defineMessages('desktop.status', {
  status: {
    needs_input: 'Needs input',
    blocked: 'Blocked',
    running: 'Running',
    ready: 'Ready',
  },
  kind: {
    thread: 'Chat',
    run: 'Work run',
    session: 'Code',
    agent: 'Agent',
  },
  newChat: 'New chat',
  /** A tray row: status, title, then the reason or the kind. */
  row: '{status}: {title} ({detail})',
  /** The quick overlay row's accessible name. */
  rowLabel: '{status}: {title}, {detail}',
  trayNeeds: '{n, plural, one {Nova: # needs input} other {Nova: # need input}}',
  trayBlocked: 'Nova: {n} blocked',
  trayBoth:
    '{needs, plural, one {Nova: # needs input, {blocked} blocked} other {Nova: # need input, {blocked} blocked}}',
});

export const CONNECT_TEXT = defineMessages('desktop.connect', {
  theHub: 'the Hub',
  invalidInput: 'Paste the Add Device link, or enter the Hub address and its fingerprint.',
  insecure:
    '{at} serves plain HTTP, which the app uses only for a Hub on this computer. Turn on HTTPS on the Hub (Network, Trust), then add this computer again.',
  unreachable: 'Cannot reach {at}. Check the address and that the Hub is running.',
  unreachableDetail: 'Cannot reach {at} ({detail}). Check the address and that the Hub is running.',
  identityUnavailable:
    '{at} cannot prove its identity right now (its identity key is not available). Check Network, Trust on the Hub. Nothing was sent to it.',
  badResponse: '{at} did not answer with a Hub identity statement. Nothing was sent to it.',
  untrustedCertificate:
    'The certificate of {at} is not trusted by this computer, and the Hub does not ask apps to pin it. Nothing was sent to it.',
  pinMismatch:
    'This is not the Hub you added: its identity does not match the fingerprint. Nothing was sent to it.',
  badSignature:
    'The identity statement of {at} did not verify, so the connection may have been tampered with. Nothing was sent to it.',
  notVouched:
    'The certificate {at} presented is not one its identity vouches for, so the connection may have been intercepted. Nothing was sent to it.',
  expired:
    'The certificate of {at} has expired. Renew it on the Hub (Network, Trust). Nothing was sent to it.',
  notALink: 'That is not an Add Device link.',
  noHub: 'The link does not name a Hub.',
  noPin:
    'The link carries no Hub fingerprint, so the app cannot check the Hub. Enter the fingerprint the Hub shows under Network, Trust.',
  enterAddress: 'Enter the Hub address, like {example}.',
  enterPin:
    'Enter the Hub fingerprint: 43 letters, digits, - and _, shown on the Hub under Network, Trust.',
  replacement:
    "This replaces {current} with another Hub, {next} (fingerprint {fingerprint}). Nova closes the current Hub's windows and deletes its data on this computer.",
});

export const CAPTURE_TEXT = defineMessages('desktop.capture', {
  noWindow: 'No window is in front to attach.',
  unknownApp:
    'Nova cannot tell which app this window belongs to, so it does not capture it (excluded apps must never be captured).',
  ownWindow: 'That is a Nova window. Bring the window you want to attach to the front first.',
  excluded: '{app} is excluded from attach window, so nothing was captured.',
  excludedUnknown: 'This app is excluded from attach window, so nothing was captured.',
  unreadable: 'The window’s text could not be read ({detail}).',
  unknownError: 'unknown error',
  windowFallback: 'Window',
  notChecked: 'The window’s text could not be checked for secrets in time, so it is left out.',
  noText: 'The window offers no text.',
  partial: 'Some of the window’s text was left out: it has more parts than the app reads at once.',
  nothingFrom: 'Nothing could be captured from {app}: {why}',
  nothingFromWindow: 'Nothing could be captured from this window: {why}',
  noImageNoText: 'no image and no text.',
  noTextMac: 'Reading window text is not available on macOS yet, so only the image is attached.',
  noTextWindows:
    'Reading window text is not available on Windows yet, so only the image is attached.',
  noTextLinux:
    'This desktop does not offer window text (its accessibility service is off), so only the image is attached.',
  attachedWindow: 'Attached window: {title}',
  nothingLeft: 'Nothing is left to attach.',
});

export const SHORTCUT_TEXT = defineMessages('desktop.shortcuts', {
  format: 'Use one or more modifiers and one key, like {example}.',
  notAKey: '{key} is not a key the app can use.',
  notAKeyEmpty: 'That is not a key the app can use.',
  notAModifier: '{key} is not a modifier (use Control, Alt, Shift, Super or Command).',
  twoModifiers: 'A global shortcut needs two of Control, Alt, Super and Command, like {example}.',
  reserved: '{key} belongs to the operating system.',
  action: {
    quickChat: 'Open quick chat',
    attachWindow: 'Attach window',
  },
  conflict: '{action}: {key} is used by another app. Choose another key.',
  duplicate: '{action}: {key} is already used by another Nova shortcut.',
  invalid: '{action}: {key} is not a valid shortcut.',
});

export const LOCAL_TEXT = defineMessages('desktop.local', {
  noNovad:
    'Local models need the Nova device agent (novad) on this computer. Add this computer on the Hub as a device with Local models, then try again.',
  noAccess:
    'The Nova device agent on this computer runs as another user, so this app cannot reach its local models. Install it with {flag} and your user name, then try again.',
  scopeMissing:
    'The Hub has not granted this computer Local models. On the Hub, open Devices, choose this computer and turn on Local models.',
  noModelServer:
    'No local model server answers on this computer. Start one (by default at {url}), then try again.',
  failed: 'The local models did not answer.',
  failedDetail: 'The local models did not answer: {detail}',
});

export const CONFIG_TEXT = defineMessages('desktop.config', {
  damaged: 'The app settings file was damaged and was set aside.',
});

/** The shell's own pages: static words, filled into `data-t` elements by the page script. */
export const PAGE_TEXT = defineMessages('desktop.pages', {
  connect: {
    title: 'Connect to your Hub',
    intro: 'Nova checks that it is talking to your own Hub before it sends anything to it.',
    replaceTitle: 'Replace your Hub?',
    keep: 'Keep the current Hub',
    addTitle: 'Add this computer',
    addHint:
      'On the Hub, open Devices, choose Add a device and Client, then paste the link it shows.',
    linkLabel: 'Add Device link',
    connect: 'Connect',
    or: 'or',
    manualTitle: 'Enter the address and fingerprint',
    urlLabel: 'Hub address',
    pinLabel: 'Hub fingerprint',
    pinHint: 'The Hub shows it under Network, Trust: 43 letters, digits, - and _.',
    checking: 'Checking the Hub…',
    couldNotCheck: 'The Hub could not be checked.',
    connected: 'Connected.',
    nothingChanged: 'Nothing changed.',
    replaceWith: 'Replace {current} with {next}',
    usesHub: 'This app uses the Hub at {url}.',
  },
  quick: {
    title: 'Quick chat',
    message: 'Message',
    placeholder: 'Ask Nova…',
    send: 'Send',
    sendTo: 'Send to',
    currentChat: 'The chat open in Nova',
    newChat: 'A new chat',
    status: 'Status',
    newTask: 'New task',
    attach: 'Attach window',
    open: 'Open Nova',
    signIn: 'Sign in to Nova to see your chats and tasks.',
    nothingYet: 'Nothing yet.',
    sending: 'Sending…',
    notSent: 'The message was not sent.',
    openChat: 'Open the chat',
    sentNew: 'Sent to a new chat.',
    sent: 'Sent.',
  },
  attach: {
    title: 'Attach window',
    nothingSentYet:
      'Nothing has been sent yet. Remove what you do not want to share, then send it to Nova.',
    image: 'Image',
    keepImage: 'Attach the image',
    imageAlt: 'Screenshot of the window',
    text: 'Text',
    keepText: 'Attach the text',
    note: 'Message (optional)',
    sendTo: 'Send to',
    currentChat: 'The chat open in Nova',
    newChat: 'A new chat',
    dataNote: 'Nova reads attached content as data, never as instructions.',
    discard: 'Discard',
    send: 'Send',
    imageAsIs: 'The image is sent as it is: check that it shows nothing private.',
    noImage: 'This system gave no image of the window.',
    notSent: 'Nothing was sent.',
    gone: 'This capture is gone.',
    fromApp: 'From {app}: {title}',
    fromWindow: 'From the window "{title}"',
    secretsMasked:
      '{n, plural, one {# secret was masked} other {# secrets were masked}} before attaching.',
    passwordsSkipped:
      '{n, plural, one {# password field was left out.} other {# password fields were left out.}}',
  },
});

/** The attach preview's sentences about a draft: where it came from and what was left out. */
export function draftNotes(d: {
  appName: string;
  windowTitle: string;
  redactions: readonly { count: number }[];
  passwordFieldsSkipped: number;
}): { source: string; redactions: string } {
  const t = PAGE_TEXT.attach;
  const source = d.appName
    ? t.fromApp({ app: d.appName, title: d.windowTitle })
    : t.fromWindow({ title: d.windowTitle });
  const notes: string[] = [];
  const masked = d.redactions.reduce((s, r) => s + r.count, 0);
  if (d.redactions.length > 0) notes.push(t.secretsMasked({ n: masked }));
  if (d.passwordFieldsSkipped > 0) notes.push(t.passwordsSkipped({ n: d.passwordFieldsSkipped }));
  return { source, redactions: notes.join(' ') };
}

export type PageKind = 'connect' | 'quick' | 'attach';

/** A page's static words, flat, for the page script (`data-t="key"`). */
export function pageText(kind: PageKind): Record<string, string> {
  const group = PAGE_TEXT[kind] as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(group)) if (typeof value === 'string') out[key] = value;
  return out;
}
