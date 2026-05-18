-- ============================================================================
-- Phase 3.5 — Default project_settings rows for /handoff skill.
--
-- Inserts known configuration keys with their default values IF NOT EXISTS.
-- Safe to re-apply (INSERT ... ON CONFLICT DO NOTHING).
--
-- Usage:
--   psql -d <db> -v project_id='<encoded_cwd>' -f scripts/sql/phase3.5-defaults.sql
--
-- The :project_id psql variable must be supplied by the caller (handoff.js init).
-- ============================================================================

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'staleness_days',              '7')
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'loader_token_budget',          '4000')
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'precision_at_5_gate_min_chunks', '1000')
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'implicit_close',               'enabled')
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'decay_rate_default',           '0.05')
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'retrieval_outcome_timeout_days', '14')
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'cluster_aware_retrieval',        'enabled')
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'cluster_max_siblings',           '10')
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO project_settings (project_id, key, value)
VALUES (:'project_id', 'tier_aware_retrieval',           'enabled')
ON CONFLICT (project_id, key) DO NOTHING;
