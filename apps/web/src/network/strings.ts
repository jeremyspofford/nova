// The words of Settings → Network (FR-016; FR-102, FR-193): the egress proxy's access levels, host
// lists, HTTPS inspection, rules for one agent, run or session, credentials and the decision log.
// Messages read at render time, so they follow the active locale. Access levels, scope kinds,
// credential schemes and block causes are the computers area's words (computers/format.ts).
import { defineMessages } from '@nova/i18n';

export const EGRESS_TEXT = defineMessages('egress', {
  title: 'Network',
  intro:
    "Sandboxes, containers and agent computers reach the network only through Nova's egress " +
    'proxy. These rules decide where they can go; every request is logged below.',
  devicesNote:
    'How your devices reach this Hub (transports, certificates, the Relay and Wake helpers) is on the {link}.',
  networkPage: 'Network page',
  loadError: 'Could not load the network rules.',
  credsLoadError: 'Could not load the credentials.',
  loadingRules: 'Loading the network rules',
  retry: 'Retry',
  cancel: 'Cancel',
  edit: 'Edit',
  remove: 'Remove',
  delete: 'Delete',
  save: 'Save',
  couldNotSave: 'Could not save: {error}',
  everySandbox: 'Every sandbox',
  /** A command without an agent, run or session. */
  aSandbox: 'A sandbox',
  /** "Agent: Research": a scope kind (computers' words) and the name or a short id. */
  scopeName: '{kind}: {name}',
});

/** The access level and host lists for every sandbox, and HTTPS inspection. */
export const ACCESS_TEXT = defineMessages('egress.access', {
  heading: 'Access for every sandbox',
  legend: 'Network access',
  announced: 'Network access: {mode}.',
  readOnlyBlocksHttps:
    'HTTPS inspection is not set up on this Hub, so read-only access blocks every HTTPS request.',
  offNote: 'The host lists below apply when network access is on.',
  allowed: 'Allowed hosts',
  addAllowed: 'Add an allowed host',
  allowedHint:
    'A host name or IP address. Use *.example.com for its subdomains; a bare * is not allowed.',
  removeAllowed: 'Remove {host} from allowed hosts',
  alsoBlocked: 'Also blocked: blocking wins',
  allowedEmpty: 'None yet: sandboxes cannot reach any host.',
  /** The owner lists none, and managed policy's own hosts are in force (ADR-097). */
  allowedNoneOwn: 'None of your own.',
  /** The allow list the proxy uses when managed policy sets a ceiling over the owner's list. */
  inForceLabel: 'Hosts in force',
  inForce: 'Sandboxes may reach now: {list}.',
  inForceNone: 'Sandboxes may reach no host now.',
  inForceWhy:
    "Your organization's policy decides this: its own hosts when you list none, else only yours that it also allows.",
  blocked: 'Blocked hosts',
  addBlocked: 'Add a blocked host',
  blockedHint: 'Always blocked, even when the host is also allowed here or in a rule.',
  removeBlocked: 'Remove {host} from blocked hosts',
});

export const INSPECTION_TEXT = defineMessages('egress.inspection', {
  heading: 'HTTPS inspection',
  on: 'On. The proxy can check HTTPS requests and add credentials to them.',
  trusted:
    "Commands in sandboxes already trust this Hub's inspection certificate. Download it to " +
    'check it, or to trust it in another tool you route through the proxy.',
  download: 'Download the certificate',
  off:
    'Off. This Hub has no inspection certificate, so read-only access blocks HTTPS and ' +
    'credentials are added to plain HTTP requests only.',
});

/** A list of host patterns, and why an entry is not a valid one. */
export const HOSTS_TEXT = defineMessages('egress.hosts', {
  typeHost: 'Type a host name or IP address.',
  already: '{host} is already in the list.',
  saveError: 'Could not save the list.',
  added: 'Added {hosts}.',
  removed: 'Removed {host}.',
  invalid: 'Not valid, remove it. {why}',
  add: 'Add',
  remove: 'Remove',
  none: 'None.',
  placeholder: 'api.example.com, *.example.org',
  problem: {
    bare: 'A bare * is not allowed: name the hosts.',
    empty: 'Empty host.',
    tooLong: 'Host name is too long.',
    notHost: 'Not a host: {host}.',
    wildcardLeft: 'A wildcard is allowed only as the leftmost label: {host}.',
    wildcardTld: 'A wildcard cannot cover a whole top-level domain: {host}.',
  },
});

export const CREDS_TEXT = defineMessages('egress.creds', {
  heading: 'Credentials the proxy adds',
  intro:
    'Nova adds a credential to requests to its hosts, so the secret never enters a sandbox. ' +
    "Values are kept in the Hub's secret store and are never shown again.",
  httpOnly: 'HTTPS inspection is off, so credentials are added to plain HTTP requests only.',
  loading: 'Loading credentials',
  empty: 'No credentials yet.',
  list: 'Credentials',
  valueSet: 'Value set',
  updated: 'Updated {when}',
  sentToHosts: 'Sent to: {hosts}',
  onlyFor: 'Only for {scope}',
  forEvery: 'For every sandbox',
  editName: 'Edit {name}',
  replaceValueOf: 'Replace the value of {name}',
  deleteName: 'Delete {name}',
  replaceValue: 'Replace value',
  add: 'Add a credential',
  added: 'Added “{name}”.',
  saved: 'Saved “{name}”.',
  replaced: 'Replaced the value of “{name}”.',
  deleted: 'Deleted “{name}”.',
  deleteTitle: 'Delete this credential?',
  deleteBody:
    'Requests to {hosts} no longer get “{name}”, and its value is removed from the secret store. This cannot be undone.',
  couldNotDelete: 'Could not delete it: {error}',
  deleteCredential: 'Delete credential',
  scheme: {
    bearer: {
      label: 'Bearer token',
      description: 'Sent as “Authorization: Bearer” and the value.',
    },
    basic: {
      label: 'User name and password',
      description: 'Sent as a Basic sign-in; the value is the password.',
    },
    header: {
      label: 'Custom header',
      description: 'Sent in a header you name, for example X-Api-Key.',
    },
  },
  headerMissing: 'Name the header, for example X-Api-Key.',
  headerChars: 'Letters, digits and hyphens only.',
  headerReserved: 'This header cannot carry a credential.',
  giveName: 'Give it a name.',
  addHost: 'Add at least one host.',
  enterValue: 'Enter the value.',
  agents: 'Agents',
  runs: 'Work runs',
  sessions: 'Code sessions',
  saveError: 'Could not save the credential.',
  editTitle: 'Edit “{name}”',
  name: 'Name',
  namePlaceholder: 'Weather API',
  sentTo: 'Sent to',
  addSentTo: 'Add a host that gets this credential',
  sentToHint: 'Only requests to these hosts get it. Use *.example.com for subdomains.',
  removeSentTo: 'Remove {host} from the hosts that get it',
  noHosts: 'No hosts yet.',
  howSent: 'How it is sent',
  headerName: 'Header name',
  headerPlaceholder: 'X-Api-Key',
  userName: 'User name (optional)',
  whoGets: 'Who gets it',
  whoGetsHint: 'Limit it to one agent, run or session, or let every sandbox use it.',
  valueStays: 'The value stays as it is. Use Replace value to change it.',
  value: 'Value',
  writeOnly: 'Write-only: it is never shown again after you save.',
  addCredential: 'Add credential',
  replaceError: 'Could not replace the value.',
  replaceTitle: 'Replace the value of “{name}”',
  replaceBody: 'The new value replaces the stored one at once. The old value cannot be recovered.',
  newValue: 'New value',
});

export const RULES_TEXT = defineMessages('egress.rules', {
  heading: 'Rules for one agent, run or session',
  intro:
    'A rule allows more hosts, or blocks more, for one agent, Work run or Code session. Its ' +
    'access can only be stricter than the access above, never wider.',
  empty: 'No rules yet.',
  list: 'Network rules',
  sameAccess: 'Same access as above',
  narrowed: '{mode} ({applied} applies)',
  moreAllowed: '{n, plural, one {# more allowed host} other {# more allowed hosts}}',
  blockedHosts: '{n, plural, one {# blocked host} other {# blocked hosts}}',
  requestRules: '{n, plural, one {# request rule} other {# request rules}}',
  devServers: 'Dev servers on private addresses',
  devServersDescription:
    'Lets commands reach private and loopback addresses, only for the hosts and ports a ' +
    'dev-server grant covers.',
  editRule: 'Edit the rule for {name}',
  removeRule: 'Remove the rule for {name}',
  add: 'Add a rule',
  saved: 'Saved the rule for {name}.',
  removed: 'Removed the rule for {name}.',
  removeTitle: 'Remove this rule?',
  removeBody:
    '{name} goes back to the access for every sandbox. Hosts allowed only by this rule are no longer reachable from it.',
  couldNotRemove: 'Could not remove it: {error}',
  removeButton: 'Remove rule',
  hookAction: {
    strip_header: 'Remove a header',
    strip_cookies: 'Remove cookies',
    block: 'Block the request',
  },
  hostProblem: 'Host: {why}',
  methodsProblem: 'Methods: letters only, for example POST, PUT.',
  pathProblem: 'Path must start with /.',
  headerProblem: 'Name the header to remove, for example Authorization.',
  chooseTarget:
    '{kind, select, agent {Choose the agent this rule is for.} run {Choose the Work run this rule is for.} other {Choose the Code session this rule is for.}}',
  hookError: 'Request rule {n}: {error}',
  saveError: 'Could not save the rule.',
  ruleFor: 'Rule for {name}',
  addTitle: 'Add a network rule',
  appliesTo: 'Applies to',
  allTaken: 'Each of them already has a rule; edit it instead.',
  noTargets:
    '{kind, select, agent {There is no agent yet.} run {There is no Work run yet.} other {There is no Code session yet.}}',
  loading: 'Loading…',
  chooseOne:
    '{kind, select, agent {Choose an agent} run {Choose a Work run} other {Choose a Code session}}',
  access: 'Access',
  sameAsEvery: 'Same as for every sandbox ({mode})',
  wider: '{mode} is wider than the access for every sandbox, so {applied} still applies.',
  moreAllowedHosts: 'More allowed hosts',
  addAllowed: 'Add an allowed host for this rule',
  removeAllowed: 'Remove {host} from more allowed hosts',
  allowedEmpty: 'None: only the hosts allowed for every sandbox.',
  moreBlockedHosts: 'More blocked hosts',
  addBlocked: 'Add a blocked host for this rule',
  removeBlocked: 'Remove {host} from more blocked hosts',
  requestRulesCount: 'Request rules ({n})',
  requestRulesHint:
    'Remove a header or cookies from matching HTTPS requests, or block them. Request rules can ' +
    'only make access stricter.',
  hookN: 'Request rule {n}',
  action: 'Action',
  host: 'Host',
  hostPlaceholder: 'api.github.com',
  header: 'Header',
  headerPlaceholder: 'Authorization',
  methods: 'Methods (optional)',
  methodsPlaceholder: 'POST, PUT',
  methodsHint: 'Empty: every method.',
  path: 'Path starts with (optional)',
  pathPlaceholder: '/repos/',
  removeHook: 'Remove request rule {n}',
  addHook: 'Add a request rule',
  saveRule: 'Save rule',
});

export const LOG_TEXT = defineMessages('egress.log', {
  heading: 'Decision log',
  intro:
    'Every request a sandbox made through the proxy, allowed or blocked, newest first. Bodies ' +
    'and full addresses are not kept.',
  loadError: 'Could not load the decision log.',
  olderError: 'Could not load older decisions.',
  filter: 'Filter the decision log',
  host: 'Host',
  hostPlaceholder: 'api.example.com',
  decision: 'Decision',
  all: 'All',
  allowed: 'Allowed',
  blocked: 'Blocked',
  filterButton: 'Filter',
  clearFilters: 'Clear filters',
  refresh: 'Refresh',
  loading: 'Loading the decision log',
  noMatch: 'No decisions match these filters.',
  empty: 'No requests yet. Requests appear here when agents or commands use the network.',
  list: 'Network decisions',
  unknownHost: 'unknown host',
  http: 'HTTP {status}',
  inspected: 'HTTPS inspected',
  address: {
    private: 'Private address',
    loopback: 'Loopback address',
    link_local: 'Link-local address',
    cgnat: 'Carrier-grade NAT address',
    unique_local: 'Unique-local address',
    multicast: 'Multicast address',
    unspecified: 'Unspecified address',
    reserved: 'Reserved address',
  },
  addressOther: 'Non-public address',
  traffic: '{received} in, {sent} out',
  allowHost: 'Allow {host}',
  showMore: 'Show more',
  allowedFor: 'Allowed {host} for {scope}.',
  allowedEvery: 'Allowed {host} for every sandbox.',
  allowError: 'Could not allow the host.',
  allowTitle: 'Allow {host}?',
  allowBody:
    'Commands can then reach this host through the proxy. A blocked host stays blocked, and ' +
    'read-only access still allows only GET, HEAD and OPTIONS.',
  allowFor: 'Allow it for',
  onlyScope: 'Only {scope}',
  addedEvery: 'It is added to the allowed hosts for every sandbox.',
  managed: 'The allowed hosts are managed by your organization.',
  allowButton: 'Allow host',
});
