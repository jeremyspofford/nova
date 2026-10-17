// Avatar images (FR-113): PNG, JPEG or WebP up to 2 MB, checked by their bytes, with embedded
// metadata (EXIF, XMP, text chunks) removed before anything is stored, so a photo never carries
// its location or camera details into the Hub.
import { NovaError } from '@nova/shared';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarMime = (typeof AVATAR_MIMES)[number];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function invalid(reason: string, message: string): NovaError {
  return new NovaError('validation', message, { details: { field: 'avatar', reason } });
}

/** The image type the bytes really are, or null. */
export function sniffImage(bytes: Buffer): AvatarMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/**
 * Decode and validate an uploaded avatar and strip its metadata. Throws `validation` for bad
 * base64, an empty or oversized image, a type other than the one declared, or a damaged file.
 */
export function prepareAvatar(mime: AvatarMime, data: string): Buffer {
  let b64 = data;
  const comma = b64.startsWith('data:') ? b64.indexOf(',') : -1;
  if (comma >= 0) b64 = b64.slice(comma + 1);
  b64 = b64.replace(/\s+/g, '');
  if (b64.length % 4 !== 0 || !BASE64.test(b64))
    throw invalid('encoding', 'the avatar is not valid base64');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) throw invalid('empty', 'the avatar is empty');
  if (bytes.length > AVATAR_MAX_BYTES) throw invalid('size', 'the avatar is larger than 2 MB');
  if (sniffImage(bytes) !== mime)
    throw invalid('content', `the avatar does not look like a ${mime} image`);
  return stripMetadata(mime, bytes);
}

export function stripMetadata(mime: AvatarMime, bytes: Buffer): Buffer {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
  }
}

// ---- JPEG: drop APP1 (EXIF, XMP), APP13 (IPTC) and comment segments ----------------------------

const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

export function stripJpeg(bytes: Buffer): Buffer {
  const damaged = () => invalid('content', 'the JPEG avatar is damaged');
  const out: Buffer[] = [bytes.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (i >= bytes.length) throw damaged();
    if (bytes[i] !== 0xff) throw damaged();
    // Fill bytes (0xFF repeated) may precede a marker.
    let m = i + 1;
    while (m < bytes.length && bytes[m] === 0xff) m++;
    if (m >= bytes.length) throw damaged();
    const marker = bytes[m]!;
    const start = m - 1;
    if (marker === 0xd9) {
      out.push(bytes.subarray(start, m + 1));
      return Buffer.concat(out);
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(bytes.subarray(start, m + 1));
      i = m + 1;
      continue;
    }
    if (m + 2 >= bytes.length) throw damaged();
    const len = bytes.readUInt16BE(m + 1);
    const end = m + 1 + len;
    if (len < 2 || end > bytes.length) throw damaged();
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data and everything after it are kept as they are.
      out.push(bytes.subarray(start));
      return Buffer.concat(out);
    }
    if (!JPEG_DROP.has(marker)) out.push(bytes.subarray(start, end));
    i = end;
  }
}

// ---- PNG: drop eXIf and the text chunks --------------------------------------------------------

const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

export function stripPng(bytes: Buffer): Buffer {
  const damaged = () => invalid('content', 'the PNG avatar is damaged');
  const out: Buffer[] = [bytes.subarray(0, 8)];
  let i = 8;
  while (i < bytes.length) {
    if (i + 12 > bytes.length) throw damaged();
    const len = bytes.readUInt32BE(i);
    const type = bytes.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > bytes.length) throw damaged();
    if (!PNG_DROP.has(type)) out.push(bytes.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  throw damaged();
}

// ---- WebP: drop the EXIF and XMP chunks and clear their VP8X flags ------------------------------

export function stripWebp(bytes: Buffer): Buffer {
  const damaged = () => invalid('content', 'the WebP avatar is damaged');
  const size = bytes.readUInt32LE(4) + 8;
  if (size > bytes.length || size < 12) throw damaged();
  const chunks: Buffer[] = [];
  let i = 12;
  while (i < size) {
    if (i + 8 > size) throw damaged();
    const type = bytes.subarray(i, i + 4).toString('latin1');
    const len = bytes.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (end > size) throw damaged();
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(bytes.subarray(i, end));
      // VP8X flags: bit 3 = EXIF present, bit 2 = XMP present.
      if (type === 'VP8X' && len >= 1) chunk[8] = chunk[8]! & ~0x0c;
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
