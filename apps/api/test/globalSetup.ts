import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Resets the test database schema and applies all migrations before the integration suite. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://cdn:cdn_dev_password@127.0.0.1:5432/cdn_test';
  const root = path.resolve(__dirname, '../../..');
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate --schema packages/database/prisma/schema.prisma', {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  fs.rmSync(path.resolve(root, '.test-data'), { recursive: true, force: true });
}
