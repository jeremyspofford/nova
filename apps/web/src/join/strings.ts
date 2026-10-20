// The joining device's words (FR-016; FR-132, FR-137): the /add-device page, its refusals in plain
// words, and the Relay path's. Messages read at render time (or when an error is made), so they
// follow the active locale.
import { defineMessages } from '@nova/i18n';

export const JOIN_TEXT = defineMessages('join', {
  addThisDevice: 'Add this device',
  checkingHub: 'Checking the Hub',
  insecureTitle: 'This page needs a secure connection',
  insecureBody:
    'This device opened the Hub over plain HTTP at a network address. Browsers allow the keys this step needs only on a secure connection, so this device cannot ask to join from here. Nothing was sent to the Hub.',
  insecureFix:
    "On the Hub, open Network → Trust and turn on the Hub's own certificate (HTTPS), install its root certificate on this device, then open the link or scan the QR code again. Or add this device with the Nova app.",
  cannotReachHub: 'Cannot reach the Hub',
  noAnswer: 'The Hub did not answer.',
  retry: 'Retry',
  wrongHubTitle: 'This is not your Hub',
  wrongHubBody:
    'This page cannot prove it is the Hub that made the code. Someone may be in the middle, so this device stops here. Do not approve a request from it on the Hub.',
  wrongHubFix:
    'Open the link or scan the QR code again on a network you trust, or ask the owner for a new code.',
  formIntro:
    'This asks the Hub to add this device. Nothing is shared until the owner approves it on the Hub.',
  formIntroRelay:
    'This asks the Hub to add this device. Nothing is shared until the owner approves it on the Hub. It pairs through the Relay, so this device can reach the Hub from anywhere.',
  badLinkCode: 'The code in the link is not valid. Type the code shown on the Hub.',
  enterCode: 'Enter the 8-character code shown on the Hub, like ABCD-EFGH.',
  codeFromLink: 'Code from the link: {code}',
  codeLabel: 'Code shown on the Hub',
  codeHint: '8 letters and digits, like ABCD-EFGH',
  nameLabel: 'Name for this device',
  nameHint: 'How it shows on the Hub. The owner can change it.',
  enterName: 'Enter a name.',
  askToJoin: 'Ask to join',
  approveTitle: 'Approve on the Hub',
  approveBody:
    'On the Hub, type this code to approve {name}. Check that it is the same on both screens.',
  retryingHub: 'Cannot reach the Hub. Trying again…',
  waiting: 'Waiting for the owner to approve this device.',
  retryingRelay: 'Cannot reach the Relay. Trying again…',
  waitingRelay: 'Waiting for the owner to approve this device, through the Relay.',
  startOver: 'Start over',
  mismatchTitle: 'The codes do not match',
  mismatchBody:
    'The Hub answered with a different code than this device worked out. Something between this device and the Hub may have changed the request, so this device stops here.',
  mismatchFix:
    'Do not approve this request on the Hub. Ask for a new code and try again on a network you trust.',
  addedTitle: 'This device is added',
  signedIn: 'You are signed in to Nova here.',
  signedInRelay:
    'You are signed in to Nova here. When the Hub’s own address does not answer, Nova reaches it through the Relay, which forwards sealed messages it cannot read.',
  openNova: 'Open Nova',
  installTitle: 'Install the app',
  installed: 'Nova is installed. Open it from your apps.',
  /** iOS: the words of its Share sheet, in {share} and {add}. */
  iosSteps: 'Tap {share}, then {add}. Nova then opens like an app.',
  iosShare: 'Share',
  iosAdd: 'Add to Home Screen',
  promptIntro: 'Install Nova to open it like an app.',
  installNova: 'Install Nova',
  /** Chromium browsers: the words of their menu, in {install} and {add}. */
  menuSteps: 'Use {install} or {add} in your browser’s menu, or keep using Nova in the browser.',
  menuInstall: 'Install app',
  menuAdd: 'Add to Home screen',
  cannotInstall:
    'This browser cannot install Nova as an app. Open it in the browser and bookmark it.',
  deniedTitle: 'Not approved',
  deniedBody: 'The owner denied this device on the Hub. It was not added.',
  useNewCode: 'Use a new code',
  expiredTitle: 'The request expired',
  expiredBody: 'It was not approved in time. Ask for a new code on the Hub, then try again.',
  failedTitle: 'This device was not added',
  noWebCrypto: 'This browser cannot make a device key here (no Web Crypto).',
});

/** Why the Hub or the Relay refused the joining device, in plain words. */
export const JOIN_ERROR_TEXT = defineMessages('join.errors', {
  generic: 'Something went wrong.',
  wrongCodeStopped:
    'That code is not right, and the Hub stopped accepting it. Ask for a new code on the Hub.',
  wrongCode: 'That code is not right. Check it on the Hub.',
  wrongCodeLeft:
    '{n, plural, one {That code is not right. # try left.} other {That code is not right. # tries left.}}',
  expired: 'This code has expired or was already used. Ask for a new code on the Hub.',
  kindNotAllowed:
    'This code is for a compute node or a Wake helper. Run the install command shown on the Hub on that computer instead.',
  keyRevoked: 'This device was revoked on the Hub. Ask the owner to add it again.',
  keyInUse: 'This device is already added. Start over to add it with a new key.',
  disabled: 'Adding devices is turned off on this Hub.',
  rateLimited: 'Too many tries from this network. Wait a minute and try again.',
  badSignature: 'The Hub did not accept this device’s signature. Start over.',
  badReveal:
    'The Hub refused this device’s answer, so the request was dropped. Ask for a new code on the Hub.',
  alreadyRevealed:
    'This request was already answered. Ask for a new code on the Hub and start over.',
  relayFull:
    'The Relay takes no more devices right now. Try again later, or ask the owner to use another Relay.',
  relayRefused: 'The Relay refused this device: {reason}.',
  relayUnreachable: 'Cannot reach the Relay. Check your connection and try again.',
  routeDropped:
    'The Relay ended this request before the Hub said why: the owner denied it, or it expired. Ask for a new code on the Hub and try again.',
  noSession: 'The Hub approved this device but did not give it a session.',
});
