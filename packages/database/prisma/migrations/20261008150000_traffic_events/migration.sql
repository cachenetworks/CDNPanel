ALTER TABLE "FileRequest" ADD COLUMN "trafficType" TEXT;
ALTER TABLE "AnalyticsDaily" ADD COLUMN "views" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsDaily" ADD COLUMN "clicks" BIGINT NOT NULL DEFAULT 0;
CREATE INDEX "FileRequest_trafficType_timestamp_idx" ON "FileRequest"("trafficType", "timestamp");
