// mDNS advertisement (FR-135, docs/22 §9.8) with a fake responder: the `_nova._tcp` records, a TXT
// record that carries only the version and the fingerprint, answers to queries, announcements on
// change, a goodbye on stop, and the IP helpers the network module uses.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  MdnsAdvertiser,
  NOVA_SERVICE_TYPE,
  directedBroadcast,
  hubMdnsName,
  inSubnet,
  interfaceAddresses,
  ipFamily,
  isLinkLocalIp,
  isLoopbackIp,
  isMeshIp,
  mdnsRecords,
  normalizeIp,
  urlIp,
  type MdnsRecord,
  type MdnsResponder,
} from '../src/index.ts';
import { iface } from './network-env.ts';

class FakeResponder extends EventEmitter implements MdnsResponder {
  readonly sent: { answers: MdnsRecord[]; additionals?: MdnsRecord[] }[] = [];
  destroyed = false;
  respond(packet: { answers: MdnsRecord[]; additionals?: MdnsRecord[] }): void {
    this.sent.push(packet);
  }
  destroy(cb?: () => void): void {
    this.destroyed = true;
    cb?.();
  }
  query(questions: { name: string; type: string }[]): void {
    this.emit('query', { questions });
  }
}

const AD = {
  name: 'study',
  port: 7419,
  addresses: ['192.168.1.10', 'fd00::5'],
  fingerprint: 'abc_DEF-123',
};

describe('mDNS records', () => {
  it('describe the service, its port and addresses, with a TXT of v=1 and the fingerprint only', () => {
    const records = mdnsRecords(AD);
    expect(records).toEqual([
      { name: '_services._dns-sd._udp.local', type: 'PTR', ttl: 120, data: NOVA_SERVICE_TYPE },
      { name: '_nova._tcp.local', type: 'PTR', ttl: 120, data: 'study._nova._tcp.local' },
      {
        name: 'study._nova._tcp.local',
        type: 'SRV',
        ttl: 120,
        data: { port: 7419, target: 'study.local', priority: 0, weight: 0 },
      },
      { name: 'study._nova._tcp.local', type: 'TXT', ttl: 120, data: ['v=1', 'fp=abc_DEF-123'] },
      { name: 'study.local', type: 'A', ttl: 120, data: '192.168.1.10' },
      { name: 'study.local', type: 'AAAA', ttl: 120, data: 'fd00::5' },
    ]);
    // No secret material of any kind rides in the advertisement.
    const txt = records.find((r) => r.type === 'TXT')!.data as string[];
    expect(txt.every((t) => /^(v=1|fp=[A-Za-z0-9_-]+)$/.test(t))).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/token|secret|nv[dce]_|key=/i);
    expect(mdnsRecords({ ...AD, fingerprint: null }).find((r) => r.type === 'TXT')?.data).toEqual([
      'v=1',
    ]);
  });

  it('take a DNS label from the host name', () => {
    expect(hubMdnsName('Jeremy’s MacBook.local')).toBe('jeremy-s-macbook');
    expect(hubMdnsName('---')).toBe('nova-hub');
    expect(hubMdnsName('a'.repeat(80))).toHaveLength(63);
    expect(hubMdnsName()).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('the advertiser', () => {
  it('announces, answers queries, re-announces changes and says goodbye', async () => {
    const fake = new FakeResponder();
    let created = 0;
    const ad = new MdnsAdvertiser({
      create: () => {
        created += 1;
        return fake;
      },
    });
    expect(ad.running).toBe(false);
    ad.advertise(AD);
    expect(ad.running).toBe(true);
    expect(ad.name).toBe('study');
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.answers).toHaveLength(6);
    // A query for the service type gets the PTR, with the rest as additionals.
    fake.query([{ name: '_nova._tcp.local', type: 'PTR' }]);
    expect(fake.sent[1]?.answers.map((r) => r.type)).toEqual(['PTR']);
    expect(fake.sent[1]?.additionals?.map((r) => r.type)).toEqual(['SRV', 'TXT', 'A', 'AAAA']);
    fake.query([{ name: 'STUDY.local', type: 'A' }]);
    expect(fake.sent[2]?.answers).toEqual([
      { name: 'study.local', type: 'A', ttl: 120, data: '192.168.1.10' },
    ]);
    fake.query([{ name: 'study._nova._tcp.local', type: 'ANY' }]);
    expect(fake.sent[3]?.answers.map((r) => r.type)).toEqual(['SRV', 'TXT']);
    // Someone else's name: no answer.
    fake.query([{ name: 'printer.local', type: 'A' }]);
    expect(fake.sent).toHaveLength(4);
    // The same advertisement again sends nothing; a change is announced.
    ad.advertise(AD);
    expect(fake.sent).toHaveLength(4);
    ad.advertise({ ...AD, addresses: ['192.168.1.11'] });
    expect(fake.sent).toHaveLength(5);
    // Without a healthy address it says goodbye and answers nothing.
    ad.advertise({ ...AD, addresses: [] });
    expect(fake.sent[5]?.answers.every((r) => r.ttl === 0)).toBe(true);
    fake.query([{ name: '_nova._tcp.local', type: 'PTR' }]);
    expect(fake.sent).toHaveLength(6);
    ad.advertise({ ...AD, addresses: ['192.168.1.11'] });
    expect(fake.sent).toHaveLength(7);
    // A new name says goodbye to the old one first.
    ad.advertise({ ...AD, name: 'den', addresses: ['192.168.1.11'] });
    expect(fake.sent[7]?.answers.every((r) => r.ttl === 0 && !r.name.startsWith('den'))).toBe(true);
    expect(fake.sent[8]?.answers[1]?.data).toBe('den._nova._tcp.local');
    await ad.stop();
    expect(fake.sent.at(-1)?.answers.every((r) => r.ttl === 0)).toBe(true);
    expect(fake.destroyed).toBe(true);
    expect(ad.running).toBe(false);
    expect(ad.records()).toEqual([]);
    await ad.stop();
    expect(created).toBe(1);
  });

  it('survives a responder that cannot start or send', async () => {
    const broken = new MdnsAdvertiser({
      create: () => {
        throw new Error('EADDRINUSE');
      },
    });
    broken.advertise(AD);
    expect(broken.running).toBe(false);
    const fake = new FakeResponder();
    fake.respond = () => {
      throw new Error('send failed');
    };
    const ad = new MdnsAdvertiser({ create: () => fake });
    ad.advertise(AD);
    fake.emit('error', new Error('boom'));
    fake.emit('warning', new Error('meh'));
    fake.query([{ name: '_nova._tcp.local', type: 'PTR' }]);
    expect(ad.running).toBe(true);
    await ad.stop();
  });
});

describe('IP helpers', () => {
  it('normalize, classify and compare addresses', () => {
    expect(normalizeIp('[FD00::5%eth0]')).toBe('fd00::5');
    expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeIp('hub.local')).toBeNull();
    expect(ipFamily('10.0.0.1')).toBe(4);
    expect(ipFamily('::1')).toBe(6);
    expect(ipFamily('nope')).toBeNull();
    expect(isLoopbackIp('127.8.0.1')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('10.0.0.1')).toBe(false);
    expect(isLinkLocalIp('169.254.1.1')).toBe(true);
    expect(isLinkLocalIp('fe80::1')).toBe(true);
    expect(isMeshIp('100.100.1.1')).toBe(true);
    expect(isMeshIp('fd7a:115c:a1e0::9')).toBe(true);
    expect(isMeshIp('100.128.0.1')).toBe(false);
    expect(inSubnet('192.168.1.200', '192.168.1.7', 24)).toBe(true);
    expect(inSubnet('192.168.2.1', '192.168.1.7', 24)).toBe(false);
    expect(inSubnet('fd00::9', 'fd00::5', 64)).toBe(true);
    expect(inSubnet('192.168.1.1', 'fd00::5', 64)).toBe(false);
    expect(inSubnet('192.168.1.1', '192.168.1.7', 40)).toBe(false);
    expect(directedBroadcast('192.168.1.7', 24)).toBe('192.168.1.255');
    expect(directedBroadcast('10.1.2.3', 16)).toBe('10.1.255.255');
    expect(directedBroadcast('10.1.2.3', 0)).toBe('255.255.255.255');
    expect(directedBroadcast('fd00::1', 64)).toBeNull();
    expect(directedBroadcast('10.1.2.3', 32)).toBeNull();
    expect(urlIp('http://[fd00::5]:7419')).toBe('fd00::5');
    expect(urlIp('http://hub.local:1')).toBeNull();
    expect(urlIp('::bad')).toBeNull();
    expect(
      interfaceAddresses({
        eth0: [iface('192.168.1.10', 24), { ...iface('10.0.0.2', 8), cidr: null }],
        lo: [iface('127.0.0.1', 8, true)],
      }),
    ).toEqual([
      { name: 'eth0', address: '192.168.1.10', family: 4, prefix: 24, internal: false },
      { name: 'eth0', address: '10.0.0.2', family: 4, prefix: 24, internal: false },
      { name: 'lo', address: '127.0.0.1', family: 4, prefix: 8, internal: true },
    ]);
  });
});
