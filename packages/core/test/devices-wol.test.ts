// Wake-on-LAN magic packets (FR-144): MAC parsing, the 102-byte packet, and a real UDP send to a
// socket listening on loopback.
import { createSocket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { magicPacket, parseMac, sendMagicPacket } from '../src/index.ts';

describe('parseMac', () => {
  it('accepts the usual spellings and refuses the rest', () => {
    expect(parseMac('aa:bb:cc:dd:ee:ff')?.toString('hex')).toBe('aabbccddeeff');
    expect(parseMac('AA-BB-CC-DD-EE-FF')?.toString('hex')).toBe('aabbccddeeff');
    expect(parseMac('aabbccddeeff')?.toString('hex')).toBe('aabbccddeeff');
    expect(parseMac('aa:bb-cc:dd:ee:ff')).toBeNull();
    expect(parseMac('aa:bb:cc:dd:ee')).toBeNull();
    expect(parseMac('gg:bb:cc:dd:ee:ff')).toBeNull();
    expect(parseMac('00:00:00:00:00:00')).toBeNull();
    expect(parseMac('ff:ff:ff:ff:ff:ff')).toBeNull();
  });
});

describe('magicPacket', () => {
  it('is six 0xff bytes and the MAC sixteen times', () => {
    const p = magicPacket('01:02:03:04:05:06');
    expect(p.length).toBe(102);
    expect(p.subarray(0, 6).every((b) => b === 0xff)).toBe(true);
    for (let i = 0; i < 16; i++)
      expect(p.subarray(6 + i * 6, 12 + i * 6).toString('hex')).toBe('010203040506');
    expect(() => magicPacket('nope')).toThrow(TypeError);
  });
});

describe('sendMagicPacket', () => {
  it('sends the packet over UDP', async () => {
    const socket = createSocket('udp4');
    await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
    const port = socket.address().port;
    const received = new Promise<Buffer>((r) => socket.once('message', (msg) => r(msg)));
    await sendMagicPacket('aa:bb:cc:dd:ee:ff', { address: '127.0.0.1', port });
    const msg = await received;
    socket.close();
    expect(msg.equals(magicPacket('aa:bb:cc:dd:ee:ff'))).toBe(true);
  });

  it('fails for a bad address', async () => {
    await expect(sendMagicPacket('zz', { address: '127.0.0.1', port: 9 })).rejects.toThrow();
  });
});
