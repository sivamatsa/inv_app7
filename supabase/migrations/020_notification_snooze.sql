-- ============================================================================
-- 020: Notification snooze - a per-user "Do Not Disturb" duration, so any
--      user (not just admin) can silence their own notification bell/toasts
--      for a while without losing anything.
-- ============================================================================
-- Deliberately a DISPLAY-layer mute, not a generation-layer one: every
-- reminder/alert generator across this app (fn_generate_reminders,
-- fn_generate_recurring_reminders, fn_generate_gold_alerts,
-- fn_generate_contact_reminders, notify_new_message, notify_missed_call,
-- ...) keeps inserting notifications exactly as it already does - snoozing
-- only tells the FRONTEND to skip the badge count and the realtime toast
-- while snoozed_until is in the future. Nothing is silently dropped: every
-- notification generated during a snooze is still sitting in the bell,
-- fully visible again the moment the snooze ends (or is turned off early).
-- Routing this through generation-time suppression instead would mean
-- touching six-plus PL/pgSQL functions across five prior migration files
-- for a UX preference that doesn't need database-level enforcement at all.
-- ============================================================================

alter table public.notification_preferences add column if not exists snoozed_until timestamptz;
