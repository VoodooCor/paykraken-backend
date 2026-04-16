-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "solanaVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "walletNonce" TEXT,
ADD COLUMN     "walletNonceExpiresAt" TIMESTAMP(3),
ADD COLUMN     "walletVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_telegramUserId_idx" ON "User"("telegramUserId");

-- CreateIndex
CREATE INDEX "User_externalId_idx" ON "User"("externalId");
