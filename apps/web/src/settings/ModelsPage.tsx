// Settings → Models (FR-221, docs/07 §8.1, §12, FR-127): the presets behind the Faster to Smarter
// control, local model servers, and routing.
import { defineMessages } from '@nova/i18n';
import { LocalServers } from './LocalServers.tsx';
import { PresetsEditor } from './PresetsEditor.tsx';
import { RoutingSection } from './RoutingSection.tsx';
import '../workspace.css';

export const MODELS_TEXT = defineMessages('settings.models', {
  title: 'Models',
  presets: 'Presets',
  local: 'Local model servers',
  routing: 'Routing',
});

export function ModelsPage() {
  return (
    <div className="settings-page">
      <h2>{MODELS_TEXT.title}</h2>
      <section className="settings-section" aria-labelledby="models-presets">
        <h3 id="models-presets">{MODELS_TEXT.presets}</h3>
        <PresetsEditor />
      </section>
      <section className="settings-section" aria-labelledby="models-local">
        <h3 id="models-local">{MODELS_TEXT.local}</h3>
        <LocalServers />
      </section>
      <section className="settings-section" aria-labelledby="models-routing">
        <h3 id="models-routing">{MODELS_TEXT.routing}</h3>
        <RoutingSection />
      </section>
    </div>
  );
}
