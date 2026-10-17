// Network (docs/04 §9; docs/22; FR-134..FR-139): the top-level surface for how this Hub is
// reached. /network and /network/:section; a setup run is /network/setup?run=<id>. On desktop the
// sections are tabs; on phones /network lists them and each one is a full page with a way back
// (docs/04 §4.3). The sandbox egress rules stay in Settings → Network, linked both ways.
import { Icon, Tabs } from '@nova/ui';
import { useLayout } from '../hooks.ts';
import { navigate } from '../router.ts';
import { followLink } from '../work/nav.tsx';
import {
  EGRESS_SETTINGS_PATH,
  NETWORK_PATH,
  NETWORK_SECTIONS,
  SECTION_INFO,
  networkPath,
  sectionFrom,
  type NetworkSection,
} from './format.ts';
import { OverviewSection } from './Overview.tsx';
import { RelaySection } from './Relay.tsx';
import { SetupSection } from './Setup.tsx';
import { TrustSection } from './Trust.tsx';
import { WakeSection } from './Wake.tsx';
import '../workspace.css';
import './netsurface.css';

function panel(section: NetworkSection) {
  switch (section) {
    case 'overview':
      return <OverviewSection />;
    case 'setup':
      return <SetupSection />;
    case 'trust':
      return <TrustSection />;
    case 'relay':
      return <RelaySection />;
    case 'wake':
      return <WakeSection />;
  }
}

function EgressLink() {
  return (
    <p className="muted ws-flush">
      Where sandboxes and agent computers may connect is set in{' '}
      <a href={EGRESS_SETTINGS_PATH} onClick={(e) => followLink(e, EGRESS_SETTINGS_PATH)}>
        Settings → Network
      </a>
      .
    </p>
  );
}

export function NetworkSurface({ section }: { section: string | null }) {
  const { layout } = useLayout();
  const current = sectionFrom(section);

  if (layout === 'phone') {
    if (!current) {
      return (
        <div className="ws-page net-page">
          <header className="ws-page-header">
            <h1>Network</h1>
          </header>
          <p className="muted ws-flush">How your devices reach this Hub.</p>
          <nav aria-label="Network sections">
            <ul className="net-menu">
              {NETWORK_SECTIONS.map((s) => (
                <li key={s}>
                  <a href={networkPath(s)} onClick={(e) => followLink(e, networkPath(s))}>
                    <span className="net-menu-text">
                      <span className="net-strong">{SECTION_INFO[s].label}</span>
                      <span className="muted net-small">{SECTION_INFO[s].description}</span>
                    </span>
                    <Icon name="forward" />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <EgressLink />
        </div>
      );
    }
    return (
      <div className="ws-page net-page">
        <nav aria-label="Breadcrumb" className="ws-breadcrumb">
          <a href={NETWORK_PATH} onClick={(e) => followLink(e, NETWORK_PATH)}>
            <Icon name="back" /> Network
          </a>
        </nav>
        <header className="ws-page-header">
          <h1>{SECTION_INFO[current].label}</h1>
        </header>
        {panel(current)}
      </div>
    );
  }

  const value = current ?? 'overview';
  return (
    <div className="ws-page net-page">
      <header className="ws-page-header">
        <h1>Network</h1>
      </header>
      <p className="muted ws-flush">
        How your devices reach this Hub: transports, certificates, the Relay and Wake helpers.
      </p>
      <EgressLink />
      <Tabs
        label="Network sections"
        className="net-tabs"
        value={value}
        onChange={(id) => navigate(networkPath(sectionFrom(id)), { replace: true })}
        items={NETWORK_SECTIONS.map((s) => ({
          id: s,
          label: SECTION_INFO[s].label,
          panel: s === value ? panel(s) : null,
        }))}
      />
    </div>
  );
}
