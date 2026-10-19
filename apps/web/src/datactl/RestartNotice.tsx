// After delete-all or an import the Hub answers, then restarts its services on the new data. This
// notice says so in a live region, waits a moment, asks the Hub's hello until it answers again, and
// reloads the page (the session stays: delete-all keeps it, an import re-points it to the
// export's owner). If the Hub stays away it says so and offers a reload.
import { useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@nova/ui';
import { useServices } from '../services.tsx';
import { DATA_PATH, DATA_STRINGS as S } from './format.ts';

export interface RestartOptions {
  /** Before the first hello (the Hub restarts once its answer is sent). Default 1.5 s. */
  delayMs?: number;
  /** Between hellos. Default 1 s. */
  intervalMs?: number;
  /** Hellos before giving up. Default 90. */
  tries?: number;
  /** Reload the app (tests replace it). */
  reload?: () => void;
}

const defaultReload = () => window.location.assign(DATA_PATH);

export function RestartNotice({ options = {} }: { options?: RestartOptions }) {
  const { api } = useServices();
  const [slow, setSlow] = useState(false);
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const { delayMs = 1500, intervalMs = 1000, tries = 90 } = opts.current;
    let left = tries;
    const attempt = () => {
      api.hello().then(
        () => {
          if (alive) (opts.current.reload ?? defaultReload)();
        },
        () => {
          if (!alive) return;
          left -= 1;
          if (left <= 0) setSlow(true);
          else timer = setTimeout(attempt, intervalMs);
        },
      );
    };
    timer = setTimeout(attempt, delayMs);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api]);
  return (
    <div className="dc-restart" role="status">
      {slow ? (
        <>
          <p>{S.restartSlow}</p>
          <Button onClick={() => (opts.current.reload ?? defaultReload)()}>{S.reloadPage}</Button>
        </>
      ) : (
        <p>
          <Spinner /> {S.restarting}
        </p>
      )}
    </div>
  );
}
