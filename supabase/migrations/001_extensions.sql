-- ============================================================================
-- 001: Extensions
-- ============================================================================
-- pgcrypto: gen_random_uuid() / digest() used for user-facing ids and the
--           payment de-duplication hash (see 004_payment_engine.sql).
-- pg_cron:  runs the nightly automation (schedule status refresh + reminder
--           generation) directly inside Postgres - see 010_cron.sql. This is
--           what replaces the Node/Edge Function server the spec assumes;
--           there is no external runtime in this deployment.
--
-- On some Supabase projects pg_cron must be enabled from the dashboard
-- (Database -> Extensions) instead of via SQL. If the statement below
-- errors with "permission denied to create extension", enable it there and
-- re-run just this file.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_cron;
