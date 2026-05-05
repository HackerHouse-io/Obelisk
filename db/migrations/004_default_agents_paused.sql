-- Pause all existing agents so the "off by default" stance from commit 8c4cb8c
-- applies retroactively. New agents already default to enabled=0; this brings
-- repos that were connected before that commit into the same state. Users
-- enable individual agents manually from Configure when they're ready.

UPDATE agents SET enabled = 0;
