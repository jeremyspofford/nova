// "New run in the cloud" where Work runs start (FR-108, FR-071): loads the cloud environments, then
// opens the Work run dialog for them, and the new run once it started. Without a usable runner or
// a ready environment the dialog says why and links to Settings → Cloud runner.
import { useState } from 'react';
import type { CloudEnvironmentView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { navigate } from '../router.ts';
import { useCloudApi } from './api.ts';
import { CloudWorkDialog } from './CloudWorkDialog.tsx';
import { CLOUD_SETTINGS_PATH } from './format.ts';

export function NewCloudWorkButton() {
  const api = useCloudApi();
  const [envs, setEnvs] = useState<CloudEnvironmentView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const start = () => {
    setLoading(true);
    api.listCloudEnvironments().then(
      ({ items }) => {
        setEnvs(items);
        setLoading(false);
        if (items.length) setOpen(true);
        else navigate(CLOUD_SETTINGS_PATH);
      },
      () => {
        setLoading(false);
        navigate(CLOUD_SETTINGS_PATH);
      },
    );
  };
  return (
    <>
      <Button disabled={loading} onClick={start}>
        {loading ? <Spinner /> : <Icon name="server" />} New run in the cloud…
      </Button>
      <CloudWorkDialog
        open={open && !!envs}
        environments={envs ?? []}
        onClose={() => setOpen(false)}
        onStarted={(v) => {
          setOpen(false);
          navigate(`/work/${encodeURIComponent(v.runId)}`);
        }}
      />
    </>
  );
}
