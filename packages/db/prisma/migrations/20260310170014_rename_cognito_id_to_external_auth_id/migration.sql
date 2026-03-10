-- RenameColumn
ALTER TABLE "User" RENAME COLUMN "cognitoId" TO "externalAuthId";

-- RenameIndex
ALTER INDEX "User_cognitoId_key" RENAME TO "User_externalAuthId_key";
