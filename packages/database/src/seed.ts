import { disconnectPrisma, getPrisma, seedDatabase } from './index.js';

const prisma = getPrisma();
seedDatabase(prisma)
  .then((r) => {
    console.log(`Seed complete: ${r.permissions} permissions, ${r.roles} new roles.`);
    console.log('Create the first administrator with: npm run create-admin');
  })
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
