import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { getPrisma } from '@cdn/database';
import { decryptField, encryptField, newId, randomBase62, sha256Hex, safeEqual } from '@cdn/shared';
import { getKeyring } from '../config/env.js';
import { getRedis } from './redis.js';

authenticator.options = { window: 1, step: 30, digits: 6 };

const aad = (userId: string) => `user_totp:${userId}`;

export function encryptTotpSecret(userId: string, secret: string): string {
  return encryptField(getKeyring(), secret, aad(userId));
}

export function decryptTotpSecret(userId: string, enc: string): string {
  return decryptField(getKeyring(), enc, aad(userId));
}

export async function totpSetup(userId: string, email: string, issuer: string) {
  const secret = authenticator.generateSecret(20);
  const otpauthUrl = authenticator.keyuri(email, issuer, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  return { secret, otpauthUrl, qrDataUrl };
}

/** Verifies a TOTP code and prevents replay of the same code within its validity window. */
export async function verifyTotp(userId: string, secret: string, code: string): Promise<boolean> {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  if (!authenticator.check(clean, secret)) return false;
  const fresh = await getRedis().set(`totp-used:${userId}:${clean}`, '1', 'EX', 120, 'NX');
  return fresh === 'OK';
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBase62(10).toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export async function storeRecoveryCodes(userId: string, codes: string[]): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({
      data: codes.map((c) => ({ id: newId('recoveryCode'), userId, codeHash: sha256Hex(normalizeRecovery(c)) })),
    }),
  ]);
}

function normalizeRecovery(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/** Consumes a recovery code if valid. */
export async function useRecoveryCode(userId: string, code: string): Promise<boolean> {
  const normalized = normalizeRecovery(code);
  if (!/^[0-9A-Z]{10}$/.test(normalized)) return false;
  const hash = sha256Hex(normalized);
  const prisma = getPrisma();
  const candidates = await prisma.recoveryCode.findMany({ where: { userId, usedAt: null } });
  const match = candidates.find((c) => safeEqual(c.codeHash, hash));
  if (!match) return false;
  const res = await prisma.recoveryCode.updateMany({ where: { id: match.id, usedAt: null }, data: { usedAt: new Date() } });
  return res.count === 1;
}
