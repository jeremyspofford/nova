// The words of "Notifications on this device" (FR-016; FR-111, FR-060): Web Push on this device,
// the devices that get notifications, and the Hub-wide switches. Messages read at render time, so
// they follow the active locale. The detail levels are DETAIL_TEXT (PushSection.tsx) and why a
// browser cannot get pushes is SUPPORT_TEXT (browser.ts).
import { defineMessages } from '@nova/i18n';

export const PUSH_TEXT = defineMessages('push', {
  heading: 'Notifications on this device',
  intro:
    'Push notifications reach this device even when Nova is closed, for the categories turned on above. Opening one goes to the run, the Code session or the approval in its conversation.',
  checking: 'Checking this browser',
  loadError: 'Could not load push notifications.',
  retry: 'Retry',
  loading: 'Loading push notifications',
  stateOn: 'On for this device.',
  stateBlocked:
    'Blocked on this device. Allow notifications in the browser’s site settings, then reload.',
  stateOff: 'Off for this device.',
  hubOff:
    'This Hub sends no push notifications now. Turn on “Send push notifications” under For every device.',
  sendTest: 'Send a test',
  turnOff: 'Turn off',
  turnOn: 'Turn on for this device',
  permissionBlocked:
    'Notifications are blocked for this site. Allow them in the browser’s site settings, then reload.',
  permissionNeeded: 'Nova needs your permission to show notifications on this device.',
  noKeys: 'The browser gave a subscription without keys.',
  turnedOn: 'Notifications are on for this device.',
  turnOnError: 'Could not turn on notifications: {error}',
  turnedOff: 'Notifications are off for this device.',
  testError: 'Could not send a test: {error}',
  saveError: 'Could not save: {error}',
  test: {
    nobody: 'There was nothing to send to.',
    sent: 'Sent. It should appear on this device in a few seconds.',
    gone: 'The push service says this device’s subscription is gone. Turn notifications on again.',
    refused: 'The push service did not take it.',
    refusedDetail: 'The push service did not take it: {detail}.',
  },
  devices: 'Devices that get notifications',
  noDevices: 'No device gets push notifications yet.',
  aBrowser: 'A browser',
  thisDevice: 'This device',
  through: 'Through {host}',
  status: {
    active: 'Working',
    failing: 'Failing',
    gone: 'Gone',
  },
  statusError:
    '{status, select, failing {Failing: {error}} gone {Gone: {error}} other {Working: {error}}}',
  lastDelivered: 'Last delivered {when}',
  nothingDelivered: 'Nothing delivered yet',
  remove: 'Remove',
  removeNamed: 'Remove {name}',
  removeThisBrowser: 'Remove this browser',
  forEvery: 'For every device',
  sendPush: 'Send push notifications',
  sendPushDescription:
    'From this Hub to every device above. Off: no device gets pushes, and Nova shows notifications only while it is open.',
  whatSays: 'What a notification says',
  detailHint:
    'Notifications to the Nova phone app go through the Relay and never say more than the kind and where.',
  stopTitle: 'Stop notifications on {name}?',
  stopTitleThis: 'Stop notifications on this browser?',
  stopBody:
    'It stops getting push notifications from this Hub. They can be turned on again on that device.',
  stopped: '{name} no longer gets notifications.',
  stoppedBrowser: 'The browser no longer gets notifications.',
});
