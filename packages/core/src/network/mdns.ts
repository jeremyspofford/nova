// mDNS advertisement of the Hub on its LAN (FR-135, docs/22 §2, §9.8): the `_nova._tcp` service
// with the Hub's port, a TXT record holding only `v=1` and the Hub fingerprint (never a secret),
// and the `<name>.local` address records of its healthy LAN addresses. The responder is
// injectable so tests check the records without touching the network.
import makeMdns from 'multicast-dns';
import { hostname as osHostname } from 'node:os';
import { Logger } from '@nova/telemetry';
import { ipFamily } from './subnet.ts';

export const NOVA_SERVICE_TYPE = '_nova._tcp.local';
const SERVICES_META = '_services._dns-sd._udp.local';
const TTL = 120;

export type MdnsRecordType = 'PTR' | 'SRV' | 'TXT' | 'A' | 'AAAA';

export interface MdnsRecord {
  name: string;
  type: MdnsRecordType;
  ttl: number;
  data: string | string[] | { port: number; target: string; priority: number; weight: number };
}

export interface MdnsQuestion {
  name: string;
  type: string;
}

/** The part of a multicast-dns instance the advertiser uses (tests pass a fake). */
export interface MdnsResponder {
  on(event: 'query', listener: (packet: { questions?: MdnsQuestion[] }) => void): unknown;
  on(event: 'error' | 'warning', listener: (err: Error) => void): unknown;
  respond(packet: { answers: MdnsRecord[]; additionals?: MdnsRecord[] }): void;
  destroy(callback?: () => void): void;
}

export interface MdnsAdvertisement {
  /** The DNS label: `<name>.local` and `<name>._nova._tcp.local`. */
  name: string;
  port: number;
  /** Healthy LAN addresses only (docs/22 §9.7). */
  addresses: string[];
  fingerprint: string | null;
}

/** A DNS label from a host name: lower case, a-z 0-9 and hyphens, at most 63, never empty. */
export function hubMdnsName(hostname: string = osHostname()): string {
  const label = hostname
    .split('.')[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return label || 'nova-hub';
}

/** Every record of the advertisement; `ttl: 0` makes them a goodbye. */
export function mdnsRecords(ad: MdnsAdvertisement, ttl = TTL): MdnsRecord[] {
  const instance = `${ad.name}.${NOVA_SERVICE_TYPE}`;
  const host = `${ad.name}.local`;
  const txt = ['v=1', ...(ad.fingerprint ? [`fp=${ad.fingerprint}`] : [])];
  return [
    { name: SERVICES_META, type: 'PTR', ttl, data: NOVA_SERVICE_TYPE },
    { name: NOVA_SERVICE_TYPE, type: 'PTR', ttl, data: instance },
    {
      name: instance,
      type: 'SRV',
      ttl,
      data: { port: ad.port, target: host, priority: 0, weight: 0 },
    },
    { name: instance, type: 'TXT', ttl, data: txt },
    ...ad.addresses.map((a): MdnsRecord => ({
      name: host,
      type: ipFamily(a) === 6 ? 'AAAA' : 'A',
      ttl,
      data: a,
    })),
  ];
}

/** The answers to one question (ANY matches every type of the name). */
function answer(records: MdnsRecord[], q: MdnsQuestion): MdnsRecord[] {
  const name = q.name.toLowerCase();
  return records.filter(
    (r) => r.name.toLowerCase() === name && (q.type === 'ANY' || q.type === r.type),
  );
}

export interface MdnsAdvertiserOptions {
  create?: () => MdnsResponder;
  log?: Logger;
}

export class MdnsAdvertiser {
  readonly #create: () => MdnsResponder;
  readonly #log: Logger;
  #responder: MdnsResponder | null = null;
  #ad: MdnsAdvertisement | null = null;

  constructor(opts: MdnsAdvertiserOptions = {}) {
    this.#create = opts.create ?? (() => makeMdns() as unknown as MdnsResponder);
    this.#log = opts.log ?? new Logger({ module: 'core.network.mdns', sinks: [] });
  }

  get running(): boolean {
    return this.#responder !== null;
  }

  get name(): string | null {
    return this.#ad?.name ?? null;
  }

  /** What is being answered now (nothing without a healthy address). */
  records(): MdnsRecord[] {
    return this.#ad && this.#ad.addresses.length > 0 ? mdnsRecords(this.#ad) : [];
  }

  /** Start answering, or update what is answered; a change is announced at once. */
  advertise(ad: MdnsAdvertisement): void {
    const before = JSON.stringify(this.#ad);
    // A new name, or no healthy address left: withdraw what was announced.
    if (this.#responder && this.#ad && (this.#ad.name !== ad.name || ad.addresses.length === 0))
      this.#goodbye();
    this.#ad = { ...ad, addresses: [...ad.addresses] };
    if (!this.#responder) {
      try {
        const r = this.#create();
        r.on('error', (err) => this.#log.warn('mDNS failed', { err }));
        r.on('warning', (err) => this.#log.debug('mDNS warning', { err }));
        r.on('query', (packet) => this.#onQuery(packet));
        this.#responder = r;
      } catch (err) {
        this.#log.warn('mDNS could not start', { err });
        return;
      }
    } else if (before === JSON.stringify(this.#ad)) {
      return;
    }
    this.#announce();
  }

  /** Say goodbye (records with TTL 0) and close the socket. */
  stop(): Promise<void> {
    const r = this.#responder;
    if (!r) return Promise.resolve();
    this.#goodbye();
    this.#responder = null;
    this.#ad = null;
    return new Promise((resolve) => {
      try {
        r.destroy(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  #onQuery(packet: { questions?: MdnsQuestion[] }): void {
    const records = this.records();
    if (records.length === 0 || !this.#responder) return;
    const answers: MdnsRecord[] = [];
    for (const q of packet.questions ?? []) {
      for (const r of answer(records, q)) if (!answers.includes(r)) answers.push(r);
    }
    if (answers.length === 0) return;
    // The rest of the service's records ride along so one round trip resolves it.
    const additionals = records.filter((r) => !answers.includes(r) && r.name !== SERVICES_META);
    this.#send({ answers, additionals });
  }

  #announce(): void {
    const records = this.records();
    if (records.length > 0) this.#send({ answers: records });
  }

  #goodbye(): void {
    if (this.#ad && this.#ad.addresses.length > 0)
      this.#send({ answers: mdnsRecords(this.#ad, 0) });
  }

  #send(packet: { answers: MdnsRecord[]; additionals?: MdnsRecord[] }): void {
    try {
      this.#responder?.respond(packet);
    } catch (err) {
      this.#log.debug('mDNS answer not sent', { err });
    }
  }
}
