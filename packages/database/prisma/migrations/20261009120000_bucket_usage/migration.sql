-- AlterTable
ALTER TABLE "StorageProvider" ADD COLUMN     "bucketObjectCount" INTEGER,
ADD COLUMN     "bucketUsagePartial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bucketUsedBytes" BIGINT,
ADD COLUMN     "usageCheckedAt" TIMESTAMP(3);
