import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Integration tests run against a dedicated database/Redis DB. Override with TEST_DATABASE_URL / TEST_REDIS_URL.
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://panel.test';
process.env.CDN_URL = 'http://cdn.test';
process.env.API_URL = 'http://cdn.test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://cdn:cdn_dev_password@127.0.0.1:5432/cdn_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
process.env.SESSION_SECRET ??= randomBytes(48).toString('base64url');
process.env.MASTER_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.STORAGE_DRIVER = 'LOCAL';
process.env.LOCAL_STORAGE_PATH = path.resolve('.test-data', 'storage');
process.env.UPLOAD_TMP_PATH = path.resolve('.test-data', 'tmp');
process.env.TRUST_PROXY = 'false';
process.env.MAX_UPLOAD_SIZE = '50MB';
process.env.LOG_LEVEL = 'silent';
process.env.DOMAIN_VERIFICATION_DISABLED = 'true';
