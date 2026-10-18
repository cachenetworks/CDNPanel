-- Share links can target a whole folder instead of a single file.
ALTER TABLE "ShareLink" ALTER COLUMN "fileId" DROP NOT NULL;
ALTER TABLE "ShareLink" ADD COLUMN "folderId" TEXT;

CREATE INDEX "ShareLink_folderId_idx" ON "ShareLink"("folderId");

ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_target_check" CHECK (("fileId" IS NULL) <> ("folderId" IS NULL));
