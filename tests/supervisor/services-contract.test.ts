// The driver contract (tests/support/service-driver-contract.ts), run against the supervisor driver
// with the stand-in service. The K3s driver (M10j) runs the same suite.
import { serviceDriverContract } from '../support/service-driver-contract.ts';
import { freePort, standIn, whoami } from '../support/services.ts';
import { supervised } from './services-support.ts';

serviceDriverContract('supervisor', async () => {
  const h = await supervised('nova-svc-contract-');
  const port = await freePort();
  return {
    driver: h.s.services,
    definition: (version, o = {}) => standIn({ version, port, flags: o.failContract ? ['--no-contract'] : [] }),
    serving: async () => (await whoami(port))?.version ?? null,
    close: () => h.stop(),
  };
});
