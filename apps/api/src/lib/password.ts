import argon2 from 'argon2';

// OWASP-recommended Argon2id parameters (m=19 MiB, t=2, p=1) raised for server hardware.
const OPTIONS = { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash) {
    // Equalise timing for unknown users / users without a password.
    await argon2.hash(password, OPTIONS);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}

export interface PasswordPolicyResult {
  ok: boolean;
  message?: string;
}

export function checkPasswordPolicy(password: string, context: { email?: string; name?: string } = {}): PasswordPolicyResult {
  if (password.length < 12) return { ok: false, message: 'Password must be at least 12 characters long.' };
  if (password.length > 256) return { ok: false, message: 'Password must be at most 256 characters long.' };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    return { ok: false, message: 'Password must contain at least three of: lowercase, uppercase, digits, symbols.' };
  }
  const lower = password.toLowerCase();
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return { ok: false, message: 'Password must not contain your email address.' };
  if (/^(.)\1+$/.test(password) || /password|123456|qwerty/i.test(password)) {
    return { ok: false, message: 'Password is too common.' };
  }
  return { ok: true };
}
