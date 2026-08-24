-- ============================================================================
-- 021: Real email delivery for notifications, via a Resend Edge Function.
-- ============================================================================
-- Every prior migration's comments (005, 019) have flagged the same standing
-- gap plainly: notifications.channel/notification_preferences.channels_enabled
-- have always had an 'Email' option in their check constraint/default JSON,
-- but nothing ever actually sent one - only 'In-app' was wired up. This
-- migration adds the one column an Edge Function needs to sweep "what's
-- still unsent" (email_sent_at), everything else needed already exists:
--   - notification_preferences.channels_enabled->>'Email' - the per-user
--     opt-in toggle (already there since 005, now finally load-bearing)
--   - notification_preferences.snoozed_until - Do Not Disturb (020) is
--     honored by the sender function too, not just the in-app bell
--   - profiles.email - the recipient address, already populated at signup
-- No new table, no RLS change: the sender function runs with the
-- service-role key (bypasses RLS by design, same as gold-price-fetch),
-- and a regular user's own access to their own notifications row is
-- unaffected - they can still see/read/delete it exactly as before,
-- email_sent_at is just one more column on a row they already own.
-- ============================================================================

alter table public.notifications add column if not exists email_sent_at timestamptz;

-- Partial index: the sender function's hot query is "unsent, recent" -
-- keeping the index narrow (only null rows) means it stays tiny forever,
-- since a sent row drops out of it the moment email_sent_at is set.
create index if not exists notifications_pending_email_idx
  on public.notifications (created_at)
  where email_sent_at is null;
