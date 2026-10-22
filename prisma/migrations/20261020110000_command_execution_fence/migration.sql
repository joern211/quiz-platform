-- Nullable for existing receipts. New claims/takeovers assign an execution
-- owner; engine transactions fence that owner and mark their first write.
-- Recovery never re-executes an intent with a committed mutation marker.
ALTER TABLE "command_receipts" ADD COLUMN "executionToken" TEXT;
ALTER TABLE "command_receipts" ADD COLUMN "mutationStartedAt" DATETIME;
