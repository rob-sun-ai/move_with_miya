ALTER TABLE "yoga_classes"
  ADD COLUMN "refundPolicy" JSONB NOT NULL DEFAULT '[{"hoursBeforeStart":24,"percentage":100}]'::jsonb;
