/**
 * GF(2^8) arithmetic for RAID-6 Q parity (Reed–Solomon over the polynomial x^8+x^4+x^3+x^2+1, 0x11d,
 * generator 2 — the same field Linux md uses).
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[(LOG[a]! + 255 - LOG[b]!) % 255]!;
}

/** g^n for the generator g = 2. */
export function gfPow2(n: number): number {
  return EXP[n % 255]!;
}

/** dst ^= src (in place). */
export function xorInto(dst: Buffer, src: Buffer): void {
  for (let i = 0; i < dst.length; i++) dst[i]! ^= src[i]!;
}

/** dst ^= coef · src (in place). */
export function mulXorInto(dst: Buffer, src: Buffer, coef: number): void {
  if (coef === 0) return;
  if (coef === 1) return xorInto(dst, src);
  const l = LOG[coef]!;
  for (let i = 0; i < dst.length; i++) {
    const s = src[i]!;
    if (s !== 0) dst[i]! ^= EXP[LOG[s]! + l]!;
  }
}

/** Returns coef · src as a new buffer. */
export function mulBuf(src: Buffer, coef: number): Buffer {
  const out = Buffer.alloc(src.length);
  mulXorInto(out, src, coef);
  return out;
}
