// "New cloud environment" where environments are listed (Code → Environments): loads the runner
// first, so the form can say when it is off or not set up, and opens the new environment's page.
import { useState } from 'react';
import type { CloudRunnerView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { navigate } from '../router.ts';
import { useCloudApi } from './api.ts';
import { CloudEnvironmentDialog } from './CloudEnvironmentDialog.tsx';
import { cloudEnvPath } from './format.ts';

export function NewCloudEnvironmentButton() {
  const api = useCloudApi();
  const [runner, setRunner] = useState<CloudRunnerView | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const start = () => {
    setLoading(true);
    api.getCloudRunner().then(
      (r) => {
        setRunner(r);
        setOpen(true);
        setLoading(false);
      },
      () => {
        // Without the runner's state the form says it is not set up, with the way there.
        setRunner(null);
        setOpen(true);
        setLoading(false);
      },
    );
  };
  return (
    <>
      <Button disabled={loading} onClick={start}>
        {loading ? <Spinner /> : <Icon name="plus" />} New cloud environment
      </Button>
      <CloudEnvironmentDialog
        open={open}
        runner={runner}
        onClose={() => setOpen(false)}
        onCreated={(e) => {
          setOpen(false);
          navigate(cloudEnvPath(e.id));
        }}
      />
    </>
  );
}
