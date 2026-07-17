import { useEffect, useState } from 'react';
import { getSettings } from './api';

/** The assistant's display name (Settings → Operator → Assistant name).
 *  Reads once, then tracks live edits via the shared setting-changed event so
 *  a rename lands everywhere without a reload. Defaults to "Nova". */
export function useAssistantName(): string {
  const [name, setName] = useState('Nova');
  useEffect(() => {
    getSettings().then(defs => {
      const v = defs.find(d => d.key === 'nova.assistant_name')?.value;
      if (typeof v === 'string' && v.trim()) setName(v.trim());
    }).catch(() => {});
    const onChange = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
      if (key === 'nova.assistant_name' && typeof value === 'string' && value.trim())
        setName(value.trim());
    };
    window.addEventListener('nova:setting-changed', onChange);
    return () => window.removeEventListener('nova:setting-changed', onChange);
  }, []);
  return name;
}
