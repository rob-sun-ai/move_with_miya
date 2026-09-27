CREATE TYPE "PaymentStatus" AS ENUM ('Pending', 'Paid', 'Failed', 'Expired', 'Refunded');
CREATE TYPE "RefundStatus" AS ENUM ('None', 'Pending', 'Succeeded', 'Failed', 'NotEligible');

CREATE TABLE "Payment" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "classId" INTEGER NOT NULL,
  "stripeCheckoutSessionId" TEXT,
  "stripePaymentIntentId" TEXT,
  "stripeRefundId" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'Pending',
  "refundStatus" "RefundStatus" NOT NULL DEFAULT 'None',
  "registrationId" INTEGER,
  "refundPercentage" INTEGER,
  "refundAmountCents" INTEGER,
  "refundRequestedAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "refundError" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payment_stripeCheckoutSessionId_key" ON "Payment"("stripeCheckoutSessionId");
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");
CREATE UNIQUE INDEX "Payment_stripeRefundId_key" ON "Payment"("stripeRefundId");
CREATE UNIQUE INDEX "Payment_active_user_class_key"
  ON "Payment"("userId", "classId")
  WHERE "status" IN ('Pending', 'Paid');
CREATE INDEX "Payment_userId_classId_status_idx" ON "Payment"("userId", "classId", "status");
CREATE INDEX "Payment_classId_status_idx" ON "Payment"("classId", "status");
CREATE INDEX "Payment_status_expiresAt_idx" ON "Payment"("status", "expiresAt");
CREATE INDEX "Payment_refundStatus_updatedAt_idx" ON "Payment"("refundStatus", "updatedAt");

CREATE TABLE "StripeWebhookEvent" (
  "id" TEXT NOT NULL,
  "stripeEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "error" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StripeWebhookEvent_stripeEventId_key" ON "StripeWebhookEvent"("stripeEventId");
CREATE INDEX "StripeWebhookEvent_status_createdAt_idx" ON "StripeWebhookEvent"("status", "createdAt");
