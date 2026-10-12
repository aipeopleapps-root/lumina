-- Agentic Workflow ("to-be") generation moves to the same async
-- trigger+worker+poll pattern already used by pi_parse/pi_agent_lld —
-- API Gateway HTTP APIs hard-cap Lambda-proxy integration timeouts at 29s
-- (non-configurable), and the richer schema + validate-with-retry loop added
-- in 006 made synchronous generation reliably exceed that ceiling.
-- Apply after 006_pi_grounding_and_agent_metadata.sql.

ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS tobe_status TEXT;
ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS tobe_error  TEXT;
