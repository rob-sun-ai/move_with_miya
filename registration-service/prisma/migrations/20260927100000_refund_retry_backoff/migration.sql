-- DropIndex
DROP INDEX "Payment_refundStatus_updatedAt_idx";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "refundAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundAvailableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "Payment_refundStatus_refundAvailableAt_idx" ON "Payment"("refundStatus", "refundAvailableAt");

