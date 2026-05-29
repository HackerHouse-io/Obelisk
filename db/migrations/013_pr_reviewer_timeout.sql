-- PR Reviewer ran with a 10-minute timeout (DEFAULT_TIMEOUT['pr-reviewer'])
-- baked onto existing agent rows at creation time. The orchestrator reads
-- agents.timeout_ms (run.ts), so changing the default constant alone only
-- helps newly-created agents. Bump existing rows to 30 min so the agent that
-- has been timing out mid-build gets the new ceiling too.
--
-- Guarded on the old default (600000 ms) so a user who deliberately tuned the
-- timeout to some other value isn't silently overwritten.

UPDATE agents
   SET timeout_ms = 1800000
 WHERE name = 'pr-reviewer'
   AND timeout_ms = 600000;
