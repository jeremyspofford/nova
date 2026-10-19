// A fake `ipmitool` for the out-of-band tests (FR-147). Run as `node fake-ipmitool.mjs <args>`;
// its state (power, boot device, the expected password, the calls it saw) is a JSON file named by
// FAKE_IPMI_STATE. Like the real program with `-E`, it reads the password from IPMI_PASSWORD only,
// and it refuses the session when the password is missing, wrong, or was put on the command line.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.env.FAKE_IPMI_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
const argv = process.argv.slice(2);
state.calls.push({ argv, passwordFromEnv: process.env.IPMI_PASSWORD === state.password });
const save = () => writeFileSync(path, JSON.stringify(state));
save();

const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

if (state.hang) setInterval(() => {}, 1000);
else {
  if (
    !argv.includes('-E') ||
    process.env.IPMI_PASSWORD !== state.password ||
    argv.includes(state.password)
  )
    fail('Error: Unable to establish IPMI v2 / RMCP+ session');
  const r = argv.indexOf('-R');
  const cmd = argv.slice(r + 2);
  const line = cmd.join(' ');
  if (line === 'chassis status') {
    process.stdout.write(
      `System Power         : ${state.power}\nPower Overload       : false\nMain Power Fault     : false\nPower Restore Policy : previous\n`,
    );
  } else if (line === 'chassis power status') {
    process.stdout.write(`Chassis Power is ${state.power}\n`);
  } else if (
    cmd[0] === 'chassis' &&
    cmd[1] === 'power' &&
    ['on', 'off', 'cycle', 'reset'].includes(cmd[2])
  ) {
    state.power = cmd[2] === 'off' ? 'off' : 'on';
    state.lastPower = cmd[2];
    save();
    process.stdout.write(`Chassis Power Control: ${cmd[2] === 'off' ? 'Down/Off' : 'Up/On'}\n`);
  } else if (line === 'sdr list') {
    process.stdout.write(
      'CPU Temp         | 45 degrees C      | ok\nFAN1             | 3600 RPM          | ok\n12V              | 12.10 Volts       | nc\nPS1 Status       | no reading        | ns\n',
    );
  } else if (line === 'chassis bootparam get 5') {
    process.stdout.write(
      `Boot parameter version: 1\nBoot parameter 5 is valid/unlocked\nBoot parameter data: 0000000000\n Boot Flags :\n   - Boot Flag Valid\n   - Boot Device Selector : ${state.bootdev}\n`,
    );
  } else if (cmd[0] === 'chassis' && cmd[1] === 'bootdev' && cmd[2]) {
    state.bootdev = `Force ${cmd[2].toUpperCase()}`;
    state.bootOptions = cmd.slice(3);
    save();
    process.stdout.write(`Set Boot Device to ${cmd[2]}\n`);
  } else fail(`Invalid command: ${line}`);
}
