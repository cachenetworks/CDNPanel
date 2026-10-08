-- CreateEnum
CREATE TYPE "StorageNodeKind" AS ENUM ('REMOTE', 'LOCAL');

-- CreateEnum
CREATE TYPE "RaidLevel" AS ENUM ('RAID0', 'RAID1', 'RAID5', 'RAID6', 'RAID10');

-- AlterEnum
ALTER TYPE "StorageKind" ADD VALUE 'POOL';

-- CreateTable
CREATE TABLE "StorageNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "StorageNodeKind" NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',
    "tokenEnc" TEXT,
    "path" TEXT NOT NULL DEFAULT '',
    "region" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "totalBytes" BIGINT,
    "freeBytes" BIGINT,
    "latencyMs" INTEGER,
    "version" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoragePool" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" "RaidLevel" NOT NULL,
    "chunkSize" INTEGER NOT NULL DEFAULT 1048576,
    "providerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "rebuildState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoragePool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoragePoolMember" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoragePoolMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageNode_name_key" ON "StorageNode"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StoragePool_name_key" ON "StoragePool"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StoragePool_providerId_key" ON "StoragePool"("providerId");

-- CreateIndex
CREATE INDEX "StoragePoolMember_nodeId_idx" ON "StoragePoolMember"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "StoragePoolMember_poolId_position_key" ON "StoragePoolMember"("poolId", "position");

-- AddForeignKey
ALTER TABLE "StoragePool" ADD CONSTRAINT "StoragePool_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "StorageProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoragePoolMember" ADD CONSTRAINT "StoragePoolMember_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "StoragePool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoragePoolMember" ADD CONSTRAINT "StoragePoolMember_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "StorageNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

