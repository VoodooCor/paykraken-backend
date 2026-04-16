/*
  Warnings:

  - You are about to drop the column `adminUserId` on the `AdminAction` table. All the data in the column will be lost.
  - Added the required column `actorType` to the `AdminAction` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "AdminAction" DROP CONSTRAINT "AdminAction_adminUserId_fkey";

-- AlterTable
ALTER TABLE "AdminAction" DROP COLUMN "adminUserId",
ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "actorLabel" TEXT,
ADD COLUMN     "actorType" TEXT NOT NULL,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetType" TEXT,
ADD COLUMN     "userAgent" TEXT;
