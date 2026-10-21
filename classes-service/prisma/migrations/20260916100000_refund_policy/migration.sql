ALTER TABLE "yoga_classes"
  ADD COLUMN "refundPolicy" JSONB NOT NULL DEFAULT '[{"hoursBeforeStart":24,"percentage":100}]'::jsonb;

-- Existing classes get the default policy for their own cutoff: a full refund
-- for any cancellation the cutoff allows.
UPDATE "yoga_classes"
  SET "refundPolicy" = jsonb_build_array(
    jsonb_build_object(
      'hoursBeforeStart', "cancellationCutoffHours",
      'percentage', 100
    )
  );
