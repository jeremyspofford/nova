// The words of the team's pages without a session (FR-016; FR-113): joining with an invitation,
// the sign-in screen's providers and a public profile card. Messages read at render time (or when
// an error is made), so they follow the active locale. Refusal reasons are the team area's words
// (team/format.ts).
import { defineMessages } from '@nova/i18n';

export const JOIN_MEMBER_TEXT = defineMessages('joinMember', {
  title: 'Join this Hub',
  checking: 'Checking the invitation',
  askIntro: 'Open the invitation link the owner of the Hub sent you, or paste it here.',
  linkLabel: 'Invitation link',
  continue: 'Continue',
  notInvitation: 'That is not an invitation link. Paste the whole link you were sent.',
  invalidTitle: 'This invitation cannot be used',
  invalidBody:
    'It was used already, withdrawn by the owner, or it has expired. Each link works once.',
  invalidFix:
    'Ask the owner of the Hub for a new link. If you already joined, open Nova and sign in.',
  openNova: 'Open Nova',
  tooManyTries: 'Too many tries',
  cannotReach: 'Cannot reach the Hub',
  noAnswer: 'The Hub did not answer.',
  retry: 'Retry',
  /** Who invited the person, and the label the owner gave the invitation, when there are. */
  invited: {
    byWithLabel: '{name} invited you ({label}).',
    by: '{name} invited you.',
    withLabel: 'You were invited ({label}).',
    plain: 'You were invited.',
  },
  expires: 'The invitation expires {when}.',
  ownAccount:
    'You get your own account on this Hub: your own chats, memory, connectors and settings. The owner runs the Hub and can remove you.',
  yourName: 'Your name',
  nameHint: 'What the people of this Hub see. You can change it later.',
  enterName: 'Enter the name the people of this Hub will see.',
  join: 'Join',
  orProvider: 'Or join with an account you already have; you then sign in with it.',
  continueWith: 'Continue with {provider}',
  joinError: 'Could not join. Try again.',
  joinedTitle: 'You joined',
  opening: 'Opening Nova…',
  unsafeAddress: 'The Hub sent an address this page will not open.',
});

export const SIGN_IN_TEXT = defineMessages('joinMember.signIn', {
  title: 'Sign in',
  loading: 'Loading sign-in options',
  linked: 'Sign in with the account you linked in Settings → Account.',
  startError: 'Could not start signing in.',
  newHere: 'New here? Open the invitation link the owner of the Hub sent you.',
});

export const PROFILE_TEXT = defineMessages('joinMember.profile', {
  region: 'Public profile',
  loading: 'Loading the card',
  missingTitle: 'No public card here',
  missingBody: 'Nobody on this Hub shows a public card at this handle.',
  errorTitle: 'Cannot show this card',
  foot: 'A public card from a Nova Hub.',
});
