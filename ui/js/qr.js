// A QR code encoder with no dependencies (ISO/IEC 18004): byte mode, error correction level M,
// versions 1 to 10, the mask with the lowest penalty. Pure: text in, modules or an SVG out, so the
// pairing sheet can draw it and the tests can decode it. The SVG draws dark modules in
// currentColor on a transparent ground with a four-module quiet zone; the stylesheet (.qr) puts it
// dark on light in every design system and mode, as scanners expect.

// Per version, level M: error correction codewords per block, and the blocks as [count, data length].
const BLOCKS = [
  null,
  [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
  [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const MAX_VERSION = 10;

const dataCapacity = (v) => BLOCKS[v][1].reduce((n, [count, len]) => n + count * len, 0);

// ---- Reed-Solomon over GF(256), polynomial 0x11D -----------------------------------------------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// ---- codewords ------------------------------------------------------------------------------------

function codewords(bytes, version) {
  const bits = [];
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCapacity(version) * 8;
  put(0, Math.min(4, capacity - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecLen, groups] = BLOCKS[version];
  const blocks = [];
  let at = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) { blocks.push(data.slice(at, at + len)); at += len; }
  }
  const divisor = rsDivisor(ecLen);
  const ecc = blocks.map((b) => rsRemainder(b, divisor));
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecc) out.push(e[i]);
  return out;
}

// ---- the matrix -------------------------------------------------------------------------------------

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(version, words, mask) {
  const size = version * 4 + 17;
  const dark = new Uint8Array(size * size);
  const fixed = new Uint8Array(size * size);
  const set = (x, y, on) => { dark[y * size + x] = on ? 1 : 0; fixed[y * size + x] = 1; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const pos = ALIGN[version];
  const last = pos.length - 1;
  pos.forEach((ay, i) => pos.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));

  // Format: level M is 00, then the mask, protected by BCH(15,5) and masked with 0x5412.
  const format = (() => {
    const v = (0 << 3) | mask;
    let rem = v;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((v << 10) | rem) ^ 0x5412;
  })();
  const fbit = (i) => ((format >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, fbit(i));
  set(8, 7, fbit(6));
  set(8, 8, fbit(7));
  set(7, 8, fbit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, fbit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, fbit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, fbit(i));
  set(8, size - 8, true); // the dark module

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }

  // Data in the zigzag, two columns at a time from the right, skipping the vertical timing column.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (fixed[y * size + x] || i >= words.length * 8) continue;
        dark[y * size + x] = (words[i >>> 3] >>> (7 - (i & 7))) & 1;
        i++;
      }
    }
  }
  const m = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y * size + x] && m(x, y)) dark[y * size + x] ^= 1;
  return { size, dark };
}

// The four penalty rules: long runs, 2×2 blocks, finder look-alikes, and dark/light balance.
function penalty({ size, dark }) {
  let score = 0;
  const at = (x, y) => dark[y * size + x];
  const lines = (horizontal) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      const cell = (b) => (horizontal ? at(b, a) : at(a, b));
      for (let b = 1; b <= size; b++) {
        if (b < size && cell(b) === cell(b - 1)) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      for (let b = 0; b + 11 <= size; b++) {
        const s = Array.from({ length: 11 }, (_, k) => cell(b + k)).join('');
        if (s === '10111010000' || s === '00001011101') score += 40;
      }
    }
  };
  lines(true);
  lines(false);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = at(x, y);
    if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
  }
  const total = size * size;
  const darkCount = dark.reduce((a, b) => a + b, 0);
  score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// The smallest version (1–10) that holds the text, as modules: { version, mask, size, dark } where
// dark[y * size + x] is 1 for a dark module. Throws when the text is too long for version 10.
// `mask` forces one mask (0–7) instead of choosing; the tests use it to decode each.
export function qrEncode(text, { mask: forced = null } = {}) {
  const bytes = new TextEncoder().encode(String(text));
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new RangeError(`That is too long for a QR code here (${bytes.length} bytes).`);
  const words = codewords(bytes, version);
  let best = null;
  for (const mask of forced === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forced]) {
    const m = build(version, words, mask);
    const p = penalty(m);
    if (!best || p < best.p) best = { ...m, mask, p };
  }
  return { version, mask: best.mask, size: best.size, dark: best.dark };
}

const QUIET = 4;

// The code as an SVG: one path of dark modules (runs merged), in currentColor, with the quiet zone
// inside the viewBox. `label` names it for screen readers.
export function qrSvg(text, { label = 'QR code' } = {}) {
  const { size, dark } = qrEncode(text);
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!dark[y * size + x]) continue;
      let run = 1;
      while (x + run < size && dark[y * size + x + run]) run++;
      d += `M${x + QUIET} ${y + QUIET}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  const n = size + QUIET * 2;
  const safe = String(label).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<svg class="qr" viewBox="0 0 ${n} ${n}" role="img" aria-label="${safe}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="${d}"/></svg>`;
}
