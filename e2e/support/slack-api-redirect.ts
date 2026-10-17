// Loaded into the Hub process with `node --import` for E2E journeys (J7): the Hub's Slack Web API
// calls (https://slack.com/api/<method>) go to the mock Slack at NOVA_E2E_SLACK_API instead. The
// Hub has no setting or environment variable for the Slack API base: `setupChannels` takes
// `slackApiBase` (apps/hub/src/channels.ts) but `buildHub` never passes one (apps/hub/src/app.ts).
const SLACK = 'https://slack.com/api';
const target = process.env.NOVA_E2E_SLACK_API?.replace(/\/+$/, '');

if (target) {
  const real = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === SLACK || url.startsWith(`${SLACK}/`))
      return real(`${target}${url.slice(SLACK.length)}`, init);
    return real(input, init);
  };
}
