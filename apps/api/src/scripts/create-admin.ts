/**
 * Securely bootstraps a Founder account:
 *   docker compose exec api npm run create-admin
 * Prompts for email, name and password (password input is hidden). Non-interactive use is
 * possible via ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD environment variables (e.g. CI),
 * which are never logged.
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { disconnectPrisma, getPrisma, seedDatabase } from '@cdn/database';
import { newId } from '@cdn/shared';
import { checkPasswordPolicy, hashPassword } from '../lib/password.js';

function ask(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc as BufferEncoding);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

async function main() {
  const prisma = getPrisma();
  await seedDatabase(prisma);

  const email = (process.env.ADMIN_EMAIL ?? (await ask('Email: '))).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email address.');
  const name = process.env.ADMIN_NAME ?? (await ask('Name: '));
  if (!name) throw new Error('Name is required.');
  const password = process.env.ADMIN_PASSWORD ?? (await ask('Password (min 12 chars): ', true));
  const policy = checkPasswordPolicy(password, { email, name });
  if (!policy.ok) throw new Error(policy.message);
  if (!process.env.ADMIN_PASSWORD) {
    const confirm = await ask('Confirm password: ', true);
    if (confirm !== password) throw new Error('Passwords do not match.');
  }

  const founder = await prisma.role.findUniqueOrThrow({ where: { name: 'Founder' } });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error(`A user with email ${email} already exists. Use the dashboard to manage existing accounts.`);
  }
  const user = await prisma.user.create({
    data: {
      id: newId('user'),
      email,
      name,
      passwordHash: await hashPassword(password),
      status: 'ACTIVE',
      roles: { create: [{ roleId: founder.id }] },
    },
  });
  await prisma.auditLog.create({
    data: { id: newId('auditLog'), actorType: 'system', actorLabel: 'create-admin CLI', action: 'USER_CREATE', targetType: 'user', targetId: user.id, metadata: { email, role: 'Founder' } },
  });
  console.log(`\nFounder account created for ${email}. Sign in to the dashboard and enable two-factor authentication.`);
}

main()
  .catch((err: unknown) => {
    console.error(`\nError: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
