// The broker process (§3). Started by the supervisor, as its own child and never core's, with
// spawn.ts's hardening: an empty environment, Node's permission model narrowed to the broker's
// folder, no inspector, --disable-sigusr1. Its two tokens arrive over Node's IPC channel, never on
// argv or in the environment.
//   node src/broker/main.ts <broker folder>
import { Broker } from './broker.ts';
import { serve, socketPath, type Tokens } from './server.ts';

const dir = process.argv[2];
if (!dir || !process.send) {
  process.stderr.write('The broker is started by the supervisor (src/broker/spawn.ts), with its folder and an IPC channel.\n');
  process.exit(2);
}

process.once('message', async (msg: { tokens?: Tokens; key_mode?: 'auto' | 'file' | 'keychain' }) => {
  try {
    const broker = new Broker({ dir, ...(msg.key_mode ? { keyMode: msg.key_mode } : {}) });
    broker.start();
    const path = socketPath(dir);
    const server = await serve(broker, path, msg.tokens!);
    const stop = () => { broker.lock(); server.close(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.send!({ ready: true, socket: path, locked: !broker.store.unlocked });
    process.channel?.unref();
  } catch (e) {
    process.send!({ ready: false, problem: (e as Error).message });
    process.exit(1);
  }
});
