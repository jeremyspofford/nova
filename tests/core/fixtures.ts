// Shared test fixtures. Neutral placeholders only: no real people, services or places.

export const sampleManifest = (over: Record<string, unknown> = {}) => ({
  id: 'example.weather',
  version: '1.0.0',
  kind: 'connector',
  name: 'Example Weather',
  capabilities: ['weather.forecast'],
  permissions: [{ kind: 'network', target: 'api.weather.example', why: 'to fetch the forecast' }],
  secrets: ['WEATHER_API_KEY'],
  config_schema: { type: 'object', properties: { city: { type: 'string' } } },
  setup_flow: null,
  health_check: { kind: 'none' },
  nova_compat: '>=0.1.0 <1.0.0',
  on_remove: { delete: ['cache'], keep: [], export: ['history.json'] },
  ...over,
});
