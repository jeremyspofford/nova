// Settings → Models (FR-221, docs/07 §8.1, §12, FR-127): the presets behind the Faster to Smarter
// control, local model servers, and routing.
import { LocalServers } from './LocalServers.tsx';
import { PresetsEditor } from './PresetsEditor.tsx';
import { RoutingSection } from './RoutingSection.tsx';
import '../workspace.css';

export function ModelsPage() {
  return (
    <div className="settings-page">
      <h2>Models</h2>
      <section className="settings-section" aria-labelledby="models-presets">
        <h3 id="models-presets">Presets</h3>
        <PresetsEditor />
      </section>
      <section className="settings-section" aria-labelledby="models-local">
        <h3 id="models-local">Local model servers</h3>
        <LocalServers />
      </section>
      <section className="settings-section" aria-labelledby="models-routing">
        <h3 id="models-routing">Routing</h3>
        <RoutingSection />
      </section>
    </div>
  );
}
