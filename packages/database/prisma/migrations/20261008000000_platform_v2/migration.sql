-- CreateEnum
CREATE TYPE "ReplicationStrategy" AS ENUM ('PRIMARY_ONLY', 'MIRROR', 'NEAREST', 'FAILOVER');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "ReplicaStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'MISSING');

-- CreateEnum
CREATE TYPE "RenditionStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "LifecycleAction" AS ENUM ('TRASH', 'DELETE', 'ARCHIVE', 'MOVE_STORAGE');

-- CreateEnum
CREATE TYPE "SecurityRuleAction" AS ENUM ('ALLOW', 'BLOCK', 'CHALLENGE', 'BAN', 'LOG');

-- CreateEnum
CREATE TYPE "SsoKind" AS ENUM ('OIDC', 'GOOGLE', 'GITHUB', 'DISCORD');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "serviceAccountId" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedReason" TEXT;

-- AlterTable
ALTER TABLE "StorageProvider" ADD COLUMN     "costEgressPerGb" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "costPerMillionRequests" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "costStoragePerGbMonth" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "healthCheckedAt" TIMESTAMP(3),
ADD COLUMN     "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "latencyMs" INTEGER,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "region" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "servesCountries" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "cacheTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "storageClass" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "FileRequest" ADD COLUMN     "cpuMs" INTEGER,
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "zoneId" TEXT;

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "rootFolderId" TEXT,
    "storageProviderId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedMimeTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxFileSize" BIGINT,
    "defaultVisibility" "Visibility",
    "edgeTtl" INTEGER NOT NULL DEFAULT 31536000,
    "browserTtl" INTEGER NOT NULL DEFAULT 86400,
    "imageOptimization" BOOLEAN NOT NULL DEFAULT true,
    "requireSignedTransforms" BOOLEAN NOT NULL DEFAULT true,
    "videoProcessing" BOOLEAN NOT NULL DEFAULT false,
    "allowedReferrers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowEmptyReferrer" BOOLEAN NOT NULL DEFAULT true,
    "allowedCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedAsns" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "replicationStrategy" "ReplicationStrategy" NOT NULL DEFAULT 'PRIMARY_ONLY',
    "replicaProviderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cloudflareZoneId" TEXT,
    "cloudflareTokenEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneDomain" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "tlsStatus" TEXT NOT NULL DEFAULT 'unknown',
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CacheRule" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "edgeTtl" INTEGER,
    "browserTtl" INTEGER,
    "bypass" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CacheRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CachePurge" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT,
    "type" TEXT NOT NULL,
    "targets" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "edgeResult" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdByLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CachePurge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileVersion" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" TEXT,
    "storageProviderId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" DOUBLE PRECISION,
    "createdById" TEXT,
    "createdByApiKeyId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileReplica" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "storageProviderId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT,
    "status" "ReplicaStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileReplica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageVariant" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "paramsHash" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "storageProviderId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "hits" BIGINT NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaRendition" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "RenditionStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "storageProviderId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "entry" TEXT,
    "mimeType" TEXT,
    "size" BIGINT NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" DOUBLE PRECISION,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaRendition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "title" TEXT,
    "message" TEXT,
    "passwordHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "maxDownloads" INTEGER,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "oneTime" BOOLEAN NOT NULL DEFAULT false,
    "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requireEmail" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByApiKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareAccess" (
    "id" TEXT NOT NULL,
    "shareLinkId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email" TEXT,
    "ip" TEXT,
    "country" TEXT,
    "userAgent" TEXT,
    "downloaded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ShareAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zoneId" TEXT,
    "folderId" TEXT,
    "basis" TEXT NOT NULL DEFAULT 'created',
    "afterDays" INTEGER NOT NULL,
    "action" "LifecycleAction" NOT NULL,
    "targetStorageProviderId" TEXT,
    "mimePrefix" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastRunCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifecycleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityRule" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT,
    "name" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "action" "SecurityRuleAction" NOT NULL,
    "banMinutes" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "hits" BIGINT NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpBan" (
    "id" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IpBan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "SsoKind" NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "issuer" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoProvision" BOOLEAN NOT NULL DEFAULT false,
    "defaultRoleId" TEXT,
    "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quota" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '',
    "metric" TEXT NOT NULL,
    "limit" BIGINT NOT NULL,
    "hard" BOOLEAN NOT NULL DEFAULT false,
    "thresholds" INTEGER[] DEFAULT ARRAY[50, 75, 90, 100]::INTEGER[],
    "alertedPercent" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKeyTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scopes" TEXT[],
    "rateLimit" INTEGER,
    "ipRestrictions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedEndpoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresInDays" INTEGER,
    "environment" "ApiKeyEnvironment" NOT NULL DEFAULT 'LIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKeyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_slug_key" ON "Zone"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_rootFolderId_key" ON "Zone"("rootFolderId");

-- CreateIndex
CREATE INDEX "Zone_projectId_idx" ON "Zone"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneDomain_hostname_key" ON "ZoneDomain"("hostname");

-- CreateIndex
CREATE INDEX "ZoneDomain_zoneId_idx" ON "ZoneDomain"("zoneId");

-- CreateIndex
CREATE INDEX "CacheRule_zoneId_priority_idx" ON "CacheRule"("zoneId", "priority");

-- CreateIndex
CREATE INDEX "CachePurge_createdAt_idx" ON "CachePurge"("createdAt");

-- CreateIndex
CREATE INDEX "FileVersion_storageProviderId_storageKey_idx" ON "FileVersion"("storageProviderId", "storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_fileId_version_key" ON "FileVersion"("fileId", "version");

-- CreateIndex
CREATE INDEX "FileReplica_status_idx" ON "FileReplica"("status");

-- CreateIndex
CREATE INDEX "FileReplica_storageProviderId_storageKey_idx" ON "FileReplica"("storageProviderId", "storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "FileReplica_fileId_storageProviderId_key" ON "FileReplica"("fileId", "storageProviderId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageVariant_fileId_paramsHash_key" ON "ImageVariant"("fileId", "paramsHash");

-- CreateIndex
CREATE INDEX "MediaRendition_status_idx" ON "MediaRendition"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MediaRendition_fileId_kind_key" ON "MediaRendition"("fileId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_tokenHash_key" ON "ShareLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ShareLink_fileId_idx" ON "ShareLink"("fileId");

-- CreateIndex
CREATE INDEX "ShareAccess_shareLinkId_timestamp_idx" ON "ShareAccess"("shareLinkId", "timestamp");

-- CreateIndex
CREATE INDEX "SecurityRule_priority_idx" ON "SecurityRule"("priority");

-- CreateIndex
CREATE INDEX "IpBan_expiresAt_idx" ON "IpBan"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");

-- CreateIndex
CREATE INDEX "WebAuthnCredential_userId_idx" ON "WebAuthnCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SsoProvider_name_key" ON "SsoProvider"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SsoProvider_slug_key" ON "SsoProvider"("slug");

-- CreateIndex
CREATE INDEX "UserIdentity_userId_idx" ON "UserIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentity_providerId_subject_key" ON "UserIdentity"("providerId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "Quota_scopeType_scopeId_metric_key" ON "Quota"("scopeType", "scopeId", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_name_key" ON "ServiceAccount"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyTemplate_name_key" ON "ApiKeyTemplate"("name");

-- CreateIndex
CREATE INDEX "ApiKey_projectId_idx" ON "ApiKey"("projectId");

-- CreateIndex
CREATE INDEX "File_deletedAt_idx" ON "File"("deletedAt");

-- CreateIndex
CREATE INDEX "File_expiresAt_idx" ON "File"("expiresAt");

-- CreateIndex
CREATE INDEX "File_cacheTags_idx" ON "File" USING GIN ("cacheTags");

-- CreateIndex
CREATE INDEX "FileRequest_zoneId_timestamp_idx" ON "FileRequest"("zoneId", "timestamp");

-- CreateIndex
CREATE INDEX "FileRequest_projectId_timestamp_idx" ON "FileRequest"("projectId", "timestamp");

-- CreateIndex
CREATE INDEX "FileRequest_country_timestamp_idx" ON "FileRequest"("country", "timestamp");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_rootFolderId_fkey" FOREIGN KEY ("rootFolderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_storageProviderId_fkey" FOREIGN KEY ("storageProviderId") REFERENCES "StorageProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneDomain" ADD CONSTRAINT "ZoneDomain_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CacheRule" ADD CONSTRAINT "CacheRule_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CachePurge" ADD CONSTRAINT "CachePurge_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_storageProviderId_fkey" FOREIGN KEY ("storageProviderId") REFERENCES "StorageProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileReplica" ADD CONSTRAINT "FileReplica_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileReplica" ADD CONSTRAINT "FileReplica_storageProviderId_fkey" FOREIGN KEY ("storageProviderId") REFERENCES "StorageProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageVariant" ADD CONSTRAINT "ImageVariant_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaRendition" ADD CONSTRAINT "MediaRendition_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareAccess" ADD CONSTRAINT "ShareAccess_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "ShareLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleRule" ADD CONSTRAINT "LifecycleRule_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityRule" ADD CONSTRAINT "SecurityRule_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "SsoProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccount" ADD CONSTRAINT "ServiceAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Data migration ─────────────────────────────────────────────────────────
-- New permissions are granted to the built-in roles here (seeding never re-grants
-- permissions to existing unlocked roles, so administrators' customisations are kept).
INSERT INTO "Permission" ("key", "description") VALUES
  ('zones.view', 'View projects, zones and domains'),
  ('zones.manage', 'Create and configure projects, zones, domains and cache rules'),
  ('cache.purge', 'Purge and pre-warm the CDN cache'),
  ('shares.manage', 'Create and revoke share links'),
  ('security.manage', 'Manage security rules, IP bans, SSO providers and service accounts'),
  ('usage.view', 'View usage, quotas and cost estimates'),
  ('quotas.manage', 'Create and change usage quotas'),
  ('ops.view', 'View operations metrics and background job queues'),
  ('ops.manage', 'Retry and remove background jobs')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT r."id", p FROM "Role" r, unnest(ARRAY['zones.view', 'zones.manage', 'cache.purge', 'shares.manage', 'security.manage', 'usage.view', 'quotas.manage', 'ops.view', 'ops.manage']) AS p
WHERE r."name" = 'Administrator'
ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT r."id", p FROM "Role" r, unnest(ARRAY['zones.view', 'zones.manage', 'cache.purge', 'shares.manage', 'usage.view', 'ops.view']) AS p
WHERE r."name" = 'Developer'
ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT r."id", p FROM "Role" r, unnest(ARRAY['zones.view', 'cache.purge', 'shares.manage']) AS p
WHERE r."name" = 'Moderator'
ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT r."id", p FROM "Role" r, unnest(ARRAY['zones.view', 'usage.view', 'ops.view']) AS p
WHERE r."name" = 'Support'
ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT r."id", p FROM "Role" r, unnest(ARRAY['zones.view', 'shares.manage']) AS p
WHERE r."name" = 'Uploader'
ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT r."id", p FROM "Role" r, unnest(ARRAY['zones.view', 'usage.view']) AS p
WHERE r."name" = 'Viewer'
ON CONFLICT DO NOTHING;

-- Every installation starts with one project that existing keys and webhooks may be assigned to.
INSERT INTO "Project" ("id", "name", "slug", "description", "updatedAt")
VALUES ('prj_0000000000000000000000000D', 'Default', 'default', 'Created automatically by the 2.0 upgrade.', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
