-- Keep the credential for accepted batches until processing is durable. A
-- claimed submit also needs it stable until the remote batch ID is committed.
-- First setup is allowed: upgraded installs need to re-enter the old key to poll.
CREATE TRIGGER openrouter_batch_key_guard
BEFORE UPDATE OF sealed_key ON ai_providers
WHEN OLD.id = 'openrouter' AND OLD.sealed_key IS NOT NULL AND NEW.sealed_key IS NOT OLD.sealed_key
  AND EXISTS (
    SELECT 1 FROM imports
    WHERE (status IN ('submitted', 'processing') AND batch_id IS NOT NULL AND key_source IS NOT 'user')
       OR (status = 'submitting' AND submission_started = 1)
  )
BEGIN
  SELECT RAISE(ABORT, 'openrouter_batch_key_in_use');
END;
