# Personal Investment Operating System

A multi-user investment/deal-tracking app (P2P loans, lending, fixed income, deposits, bonds,
gold schemes, and anything else you add) built against the 55-section spec in
`Investment_Portfolio_Supabase_Skill.docx`. Supabase (Postgres + Auth + Storage + pg_cron) is the
entire backend — there is no Node.js server anywhere in this stack, by design (see Architecture
below). The frontend is a static site: open `web/index.html` directly, or host the `web/` folder
on literally anything that serves static files (Netlify, Vercel static, GitHub Pages, Supabase
Storage, a plain S3 bucket, etc.) — no build step.

## Try it in 10 seconds (no setup)

Open `web/index.html` and click **"Try with Sample Data"** on the sign-in screen. That drops you
straight into every view (Dashboard, Deals, Payments, Analytics, ...) backed by an in-browser
sample portfolio — no Supabase project, no account, nothing saved anywhere. It's real UI wired to
fake data, not screenshots: create a deal, record a payment, run the What-If simulator, all of it
works. A banner stays up the whole time so it's never ambiguous that it's not your real data;
**Exit Demo** returns to the real sign-in screen. This is the fastest way to see the app working —
do this before setting up a real Supabase project.

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com) if you don't have one.
2. **Run the migrations in order.** Open your project's SQL Editor and run each file in
   `supabase/migrations/` in numeric order (`001_extensions.sql` through
   `039_ai_copilot_providers.sql`) — paste the contents of each file and run it before
   moving to the next. They're idempotent
   (`create table if not exists`, `drop policy if exists` before `create policy`, etc.), so
   re-running a file if you're unsure whether it applied is safe.
   - `001_extensions.sql` enables `pg_cron`. If that statement errors with a permissions message,
     enable it instead from the dashboard: **Database → Extensions → pg_cron**, then re-run just
     that file (it'll skip the extension line and still be needed for later files to build on).
   - `010_cron.sql` registers the original nightly automation job; `014_community_notes_tickets.sql`
     replaces it with one that runs every 15 minutes instead (see "Notifications" below), and
     `015_recurring.sql` folds the recurring-item automation into that same 15-minute job — run all
     three in order, each one supersedes the last correctly.
3. **Create the `documents` storage bucket** — `011_storage.sql` does this via SQL
   (`insert into storage.buckets`), so this normally needs no manual step. If your project's SQL
   Editor role can't insert into `storage.buckets`, create a **private** bucket named `documents`
   from the dashboard instead (**Storage → New bucket**), then re-run `011_storage.sql` for the RLS
   policies.
4. **Open `web/index.html`** (double-click it, or serve the `web/` folder from any static host).
   On first load it asks for your Supabase **Project URL** and **publishable/anon key** — both are
   found in your project's **Settings → API** page, and both are safe to use in client-side code
   (Row Level Security is what actually protects the data, not secrecy of this key).
5. **Create an account** from the sign-up tab. A `profiles` row is created for you automatically
   (via the `handle_new_user` trigger from `003_profiles_platforms_deals.sql`). Anyone else you
   share the app's URL with can create their own account the same way — every new signup gets a
   fully isolated portfolio automatically, no extra setup needed per user.
6. **Make yourself admin (optional).** Run this once in the SQL Editor, after signing up:
   ```sql
   update public.profiles set is_admin = true where email = 'your@email.com';
   ```
   An admin sees an extra **Admin** section in the sidebar listing every registered user, with a
   read-only drill-in into each person's portfolio. This is view-only by design — an admin cannot
   edit another user's deals or payments through the app, only see them (details in
   `013_admin_role.sql`). Everyone else only ever sees their own data, exactly as before.
7. Start adding deals, or use **Import** to upload an Excel/CSV file — `Investment_Import_Template.xlsx`
   is a single source-of-truth workbook: Deals, Payments, Recurring Items,
   Recurring History, and Bank Reconciliation sheets, every dropdown-backed field as a real Excel
   data-validation dropdown, sample rows covering every investment type and all 23 recurring item
   types, and an Instructions sheet documenting required vs optional fields per sheet plus exactly
   how each one gets imported (the first four upload together via the Import page; Bank
   Reconciliation uploads separately via Payments → Bank Reconciliation, since that's a different
   uploader in the app). Re-importing it is safe - nothing duplicates. It's also downloadable directly
   from inside the app now — a "Download the Import Template" link on the Import page's first step,
   not just a file you have to know to look for alongside this README.

## Newer features

- **Notifications now push in real time.** Every user's `notifications` table is on Supabase
  Realtime (Postgres Changes, RLS-scoped — a regular user only ever receives events for their own
  rows), so a new notification appears immediately instead of waiting for the app's 60-second poll.
  The underlying checks (overdue payments, upcoming maturities, etc.) also now run every 15 minutes
  instead of once a night — admin can additionally force an immediate run from the **Admin** page's
  "Run Automation Now" button.
- **Community** — one shared chat room, open to every signed-in user, live via Realtime. This is
  the one place in the app where messages are visible across users on purpose (everywhere else stays
  strictly per-user).
- **Message to Us** — support tickets with a unique ticket number, a reply thread, and a status
  workflow (Open → In Progress → Resolved → Closed). A regular user sees only their own tickets;
  admin sees every ticket and is notified the moment a new one is created — the one deliberate
  exception to admin being read-only elsewhere, since replying and resolving tickets requires it.
- **Notes** — a private per-user scratchpad. Deliberately *not* visible to admin, unlike the
  financial tables — these aren't portfolio data.
- **Interest Calculator** — quick-select common amounts/rates, a monthly/quarterly/yearly/compounding
  breakdown, and a comparison against your own portfolio's average ROI. That comparison is a plain
  rule-based calculation, not a live AI/LLM call — there's no server here that could hold a model
  API key safely, so it only ever compares two real numbers, the same honest substitution already
  used for AI Insights.
- **Deals** now has All / Active / Closed tabs, and the **Dashboard** shows deal counts *and* amounts
  for each bucket.
- **Dark / light mode** — a toggle (moon/sun icon, topbar and the sign-in screen) that every user
  controls for themselves. It's a per-browser preference (`localStorage`), not a shared setting —
  there's no server-side concept of "the app's theme," so each person picks their own.

## Recurring Investments & Commitments

A second, deliberately **separate** module (new **Recurring** nav item) for SIPs, mutual funds,
gold schemes, insurance, credit cards, rent, and any other repeated financial commitment — as
opposed to **Deals**, which track capital deployed into something that generates a return. The two
are never mixed: a recurring outflow is never interpreted as a deal return, and confirming a
period is a different operation from recording a deal payout (`015_recurring.sql`'s header comment
has the full rationale).

The core rule: **a due date arriving never auto-completes anything.** Each period ("occurrence") is
its own row, generated ahead of time (90-day rolling lookahead), moving `UPCOMING → DUE → OVERDUE`
entirely on its own — but it only ever becomes `CONFIRMED`/`PAID`/`INVESTED`/`PARTIALLY_PAID`/
`SKIPPED` through your own explicit **Confirm** action. Reminders (per-item day-before/overdue
offsets), pause/resume (never backfills overdue periods for a paused window), and future amount/
frequency changes (history stays untouched — only new occurrences pick up the change) all build on
that same rule.

Three places this deliberately reuses the app's existing infrastructure rather than duplicating it:
- **Reminders reuse the existing `notifications` table** (new `'Recurring Reminder'`/
  `'Recurring Overdue'` types added to its check constraint) — same bell icon, same realtime push,
  same dedupe-key idempotency every other notification in this app already uses. There's no second,
  parallel notification system.
- **Investment-performance tracking** (optional, for SIP/Mutual Fund/Gold/Stocks items) is two
  extra columns on each occurrence (`actual_units`, `actual_nav`), not a separate position-tracking
  subsystem. It answers "what did this period's investment become worth", not full NAV-history
  charting against an external market data feed — that's a natural follow-up, not built here.
- **One calendar, not two.** The existing **Calendar** page got a type filter (All / Deals /
  Investments / Bills / Insurance / SIP / Gold / Stocks / Rent / Credit Card) and now overlays
  recurring due-dates alongside deal payment-schedule events, rather than a second calendar page.

Also wired up: the **Dashboard** has its own "Recurring Investments & Commitments" panel (This
Month Expected/Confirmed/Yet to Confirm/In Progress/Overdue, Next 7/30 Days) that never feeds into
the Deals KPIs above it, and the "Needs Your Attention" widget now combines Deals and Recurring
rows in the same Due-Today/Overdue lists, each one clearly labeled by source (e.g. "Investment
Deal — ..." vs "SIP — ..."), clicking through to the right module either way. **Import** gained two
more auto-detected sheet types, "Recurring Items" and "Recurring History", usable independently or
alongside the existing Deals/Payments sheets in the same file — repeated imports don't duplicate
occurrences, enforced by a database-level unique constraint, not just client-side checking.

## Contacts, Private Chat, Calling & WhatsApp Integration

A third, self-contained module (new **Contacts & Chat** nav group) for a personal address book,
private 1:1/group messaging, and best-effort voice/video calling — kept **completely separate**
from Deals, Recurring Investments, Community Discussion, and Message to Us. No table, nav item, or
notification type is shared between this module and any financial or community feature, and
Community/Message to Us were not touched at all while building it (their files have no edits in
this change).

**Contacts** — rich profiles (name, nickname, birthday, photo, tags, favorite), multiple phones/
emails/addresses per contact with labels (Primary/Secondary/WhatsApp/Work/Home, etc.), groups,
per-contact notes and follow-up reminders, and an action bar (Call `tel:`, WhatsApp deep link,
Email, Favorite). **Portfolio Discovery** (`find_portfolio_user()`) lets you find another
registered user by exact email/mobile/username match — gated by *their* privacy settings
(Anyone/Contacts/Nobody for "who can find me"), and designed so a blocked search and a
privacy-blocked search look identical from the outside (no "exists but private" leak). Excel/CSV
import reuses the same wizard as Deals/Recurring (auto-detects a "Contacts" sheet), and adds
**duplicate detection** — matched by phone, email, or name against your existing contacts, and
also against other rows in the same file — with a per-row **Merge / Keep as Separate / Skip**
choice before anything is saved. Merge only ever fills in blanks and adds new phones/emails/notes;
it never overwrites a field that already has a value.

**Private Chat** — 1:1 and group conversations, message status (Sending/Sent/Failed/Deleted),
reactions, reply, edit (with an edit history log), "Delete for Me" vs "Delete for Everyone", and
search. Adding someone to a 1:1 chat always spawns a **new** group conversation with an explicit
history-cutoff choice (Past Hour/Today/Past Week/All/Custom) — a newly added member's own
`history_visible_from` timestamp is enforced inside the database's own row-level security policy
on `messages`, not just filtered client-side, so pre-join history is genuinely unreadable to them,
not merely hidden by the UI. **Sharing** past messages into another conversation copies the
selected messages as new rows (never a live reference back), so a share can't retroactively leak
more than what was explicitly picked.

**Calling** is real WebRTC (`RTCPeerConnection`) with Supabase Realtime **broadcast** channels for
signaling (offer/answer/ICE candidates) — no media server, so it uses public STUN servers only,
**no TURN relay**. This means calls will fail across networks with symmetric NAT or strict
firewalls; a 25-second no-answer/no-connect timeout surfaces phone (`tel:`) and WhatsApp fallback
buttons directly in the failure screen rather than leaving you stuck. Calling is 1:1 only — no
group calls. Microphone/camera access is only ever requested after you explicitly start or accept
a call, never silently or in the background.

A few scope decisions worth stating plainly rather than leaving you to discover them:

- **No admin visibility into Contacts or Chat, at all.** Every table in this module has RLS with
  no `private.is_admin()` bypass clause anywhere — the opposite default from most of this schema
  (Deals/Payments/Recurring all give the admin account a deliberate read-only bypass). Contacts and
  Chat are private personal data, same category as `notes`.
- **Chat is not end-to-end encrypted.** It's authenticated and RLS-protected like every other table
  in this app, but the database itself can read every message — the same honesty already applied
  to "AI Insights" (rule-based, not a live model) and dark mode (a preference, not a security
  boundary). Don't rely on this for anything that needs true E2EE.
- **New message/mention/call/birthday/reminder notifications reuse the existing `notifications`
  table** (new `type` values added to its check constraint) — same bell icon, same realtime push,
  same dedupe-key idempotency as every other notification in this app. There's no second, parallel
  notification system for chat.
- **No accept/invite workflow for group membership.** Any group ADMIN/OWNER adds a member directly,
  same as most consumer chat apps — the privacy protection is the history-cutoff on join described
  above, not a request-accept handshake.
- **Device contact sync is progressive enhancement, not a built feature.** The Contact Picker API
  (`navigator.contacts.select()`) only exists on Chrome for Android; the import button is
  feature-detected and simply doesn't render anywhere else, rather than faking a capability most
  platforms don't have.

## Gold Intelligence

A live gold-price layer — 24K/22K/18K per gram/5g/8g/10g/100g/1kg, a historical chart with selectable
periods, moving averages/relative-price analytics, a trend-based projection panel, a read-through into
the existing Recurring Investments Gold Scheme/Gold Savings items, a buying-power calculator, a
portfolio impact simulator, a standalone physical-gold purchase log, and an allocation monitor.

**This is the first feature in the app that needs a real outbound HTTPS call to a third party with a
secret API key** — something Postgres/RLS alone can't do safely. That required one genuinely new piece
of infrastructure: a Supabase **Edge Function** (`supabase/functions/gold-price-fetch/`), which breaks
this project's "every migration is the whole runbook" convention for the first time. That's disclosed
here plainly rather than glossed over — see the deploy steps below.

**Provider comparison** (researched live, not guessed) — all three convert international spot gold to
INR; **none give a genuine Indian retail/duty-adjusted rate**, so every price in this module is
labeled "International Spot (converted to INR)," never "Indian retail rate":

| Provider | Free tier | Notes |
|---|---|---|
| **goldprice.dev** `/v1/carat` (default) | Free, keyless, no signup at all | Works out of the box before you configure anything |
| **MetalpriceAPI** | 100 req/month free, daily updates | Cheapest to scale ($5/mo for 30-min updates) |
| **GoldAPI.io** | 500 req/month free, no card | Alternate primary |
| *Custom (your own)* | — | Add via Settings → Gold Price Provider; supports any API that returns a spot price (troy oz or gram) — this app computes the 22K/18K purity math itself |

**Deploying the Edge Function** (one-time, via the [Supabase CLI](https://supabase.com/docs/guides/cli)):

```bash
supabase functions deploy gold-price-fetch
supabase secrets set METALPRICEAPI_KEY=your_key_here
supabase secrets set GOLDAPI_KEY=your_key_here
```

goldprice.dev needs no key at all — it works immediately after `019_gold_intelligence.sql` is applied
(it's the seeded default provider). For a custom provider, set whatever secret name you chose in the
Add Custom Provider form (it must start with `GOLD_CUSTOM_`), e.g.
`supabase secrets set GOLD_CUSTOM_MYPROVIDER=your_key_here`.

**Daily automatic refresh**: in the Supabase Dashboard, go to **Database → Cron Jobs** and schedule an
invocation of the `gold-price-fetch` Edge Function (once a day is the default assumption throughout
this module, though you can point it at any interval Supabase's Cron Jobs UI allows). This is
deliberately a dashboard step, not a SQL migration — doing it via `pg_net`/Vault would mean storing a
service-role key inside SQL, which is a worse trade than one dashboard click. The in-app **Refresh
Now** button (Gold Intelligence page and Settings → Gold Price Provider) doesn't need any of this — it
calls the function directly from your own signed-in session.

**Not yet verified against a live provider.** Every provider's request/response shape here was
written from that provider's own public documentation, not a live test call — there was no live
Supabase project or provider API key available while building this (the same honest caveat as every
other feature in this app that couldn't be tested against real Supabase). If a real response doesn't
match what's parsed, the error surfaces in Settings → Gold Price Provider (and in
`gold_providers.last_error`) with the actual response shape received, which is the fastest way to fix
the mapping — the same debug loop used for every SQL migration in this project.

**Projections + Monte Carlo + Purchase Timing Score** — the projection panel's four trend-based
methods (moving-average trend / historical CAGR / linear trend / user-defined growth) each show
Conservative/Base/Optimistic bands. An optional **Monte Carlo** toggle overlays a percentile-based
distribution instead (Box-Muller draws for standard-normal returns, simulated entirely client-side
over the same fetched history — no new backend or schema). A **Purchase Timing Score** panel sits
next to Relative Price: a transparent, itemized 0–100 score built from signed, labeled components
(position in recent range, momentum vs moving averages, volatility) rather than a black-box number —
per the spec's own "never a guaranteed prediction" requirement, every component is shown, not just
the total.

Scope decisions worth stating plainly:
- **No India-vs-global/city price comparison.** All three built-in providers return one INR number;
  comparing against XAU/USD, USD/INR, and MCX needs a data source with that coverage, addable later
  through the same custom-provider slot.
- **Daily/weekly summaries are in-app panels, not emails.** (Real email delivery now exists for
  *notifications* — see "Email Notifications" below — but the Gold Summary itself stays an in-app
  card; it was never a notification-generating event.)
- **Gold Scheme integration is a read-only join** into the existing Recurring Investments tables
  (`recurring_items`/`recurring_occurrences`), not a schema change to that module — so "never overwrite
  a real purchase price with today's live price" is guaranteed by construction, not by convention.

## Global Search

One search bar in the topbar (every page, next to the page title) that queries Deals, Recurring
Investments, Contacts, Chat conversations, Gold Purchases, Notes, Message to Us tickets, Platforms,
and — admin only — every registered user's profile, all in parallel, grouped by type in a dropdown.
Clicking a result navigates to the right view and opens the exact record's detail modal (deep-linking
through each view's existing `App.<view>View.openXDetail` export — the same pattern the Dashboard's
"Needs Your Attention" widget already used, just reused here instead of invented). A small
recommendations row ("Open Contacts", "Open Gold Intelligence", …) appears under the results based on
which groups matched.

It deliberately runs through the exact same `App.api` functions every view already calls — so it's
automatically subject to the same RLS/self-scoping rules as everywhere else (a regular user's search
never sees another user's deals, contacts, or chats; the Admin — Users group only ever appears for an
admin session, enforced by RLS, not just hidden in the UI). It does **not** search message content or
call history — paging through every conversation's own `history_visible_from` window per keystroke is
a meaningfully bigger feature on its own, and Chat conversation names + Contacts already answer "who
do I need to talk to."

## Installable App (PWA)

"Add to Home Screen" now installs a real standalone app instead of a browser-chrome URL shortcut that
just reopens the browser. Four pieces, all required together:
- `web/manifest.json` — `display: "standalone"`, `start_url`, `scope`, and icon sets including
  maskable variants for Android's adaptive-icon shapes.
- `web/sw.js` — a Service Worker registered from `index.html` after the page loads. Deliberately
  **same-origin only**: it checks `url.origin` before touching the cache, so it can never intercept —
  and therefore never serve stale — a Supabase API call or a cross-origin CDN script. Network-first,
  falling back to cache only when offline.
- `web/icons/` — app icon, maskable icon, and Apple touch icon, matching the app's own navy/gold brand
  colors.
- iOS-specific `<meta name="apple-mobile-web-app-capable">` / `apple-touch-icon` tags in
  `index.html`'s `<head>` — Safari doesn't fully respect `manifest.json`, so it needs its own tags to
  install as standalone rather than just a bookmark.

On Android Chrome, look for the "Install app" prompt (or Menu → Install app). On iOS Safari, use
Share → "Add to Home Screen." Either way, the icon that lands on the home screen now opens without
browser chrome, like any other installed app.

## Email Notifications

Closes this project's oldest documented gap: every notification (payment due, maturity approaching,
recurring reminders, gold alerts, new chat messages, …) has always generated an in-app row, but only
`In-app` was ever actually *delivered* — `Email`/`Push`/`WhatsApp`/`Telegram` sat in the schema as
unused options since migration `005`. This ships the `Email` half of that.

Turn it on in **Settings → Reminder Preferences → Email Notifications**, which is a single per-user
cadence — `notification_preferences.email_frequency` — not a plain on/off toggle:

| Value | Meaning |
|---|---|
| `never` | Off. |
| `1_day` (default) | A digest at most once a day. |
| `5_days` / `7_days` / `10_days` | A digest every N days. |
| `1_month` / `3_months` | A digest every 1 or 3 months. |

Whatever piled up since your last digest goes out as **one email** (not one email per notification) —
each notification appears as its own item inside it. Two things that apply regardless of cadence:
- **Do Not Disturb is honored.** While snoozed (Settings → Reminder Preferences → Do Not Disturb), no
  digest goes out; it's simply reconsidered on the next sweep once the snooze ends.
- **The lookback is capped at 90 days**, even for `3_months` or a brand-new opt-in after a long gap —
  stops an old backlog from ever landing in one inbox as a wall of ancient reminders.

**New infrastructure**: a Supabase Edge Function, `supabase/functions/send-notification-emails/`,
that (for every user who's due) builds one digest of their still-unsent notifications and sends it via
[Resend](https://resend.com)'s REST API (no SDK dependency). Deploy it the same way as
`gold-price-fetch`:

```bash
supabase functions deploy send-notification-emails
supabase functions deploy email-unsubscribe --no-verify-jwt
supabase secrets set RESEND_API_KEY=re_your_key_here
supabase secrets set RESEND_FROM_EMAIL="Investment OS <notifications@yourdomain.com>"
supabase secrets set UNSUBSCRIBE_SECRET=$(openssl rand -hex 32)
```

`RESEND_FROM_EMAIL` must be an address on a domain **verified in your Resend account** (Domains tab →
Add Domain → add the DNS records Resend gives you) — Resend rejects any other sender outright,
including a personal inbox address, since you can't add DNS records to a domain you don't control.
That failure surfaces per-user in the function's own JSON response (an `errors: [{user_id, error}]`
array) and in Function Logs, not as a silent no-op. Omitting the secret falls back to Resend's sandbox
sender `onboarding@resend.dev`, which can only deliver **to** the exact email address your Resend
account itself is registered under — fine for solo testing, not for real multi-user delivery.

**Testing it right now**: Settings → Reminder Preferences → Email Notifications has a **"Trigger
Emails Now"** button, visible to admin only (one call sweeps every opted-in user, not just you — same
reasoning as Admin's "Run Automation Now"). It invokes the function immediately and toasts back a
summary (`digestsSent`, `notificationsEmailed`, `usersSkipped`, `usersFailed`) so you don't have to
wait for the schedule below just to confirm your Resend setup works.

**Automatic delivery**: same pattern as Gold Intelligence's price refresh — in the Supabase Dashboard,
go to **Database → Cron Jobs** and schedule this function every few minutes (it's cheap to call even
for users who aren't due yet — they're just skipped). Deliberately a dashboard step, not `pg_net`/
Vault, for the same reason as `gold-price-fetch`: this project has never stored a service-role key
inside SQL, and one dashboard click is a better trade.

### Gmail rejecting emails as "likely unsolicited mail" (550-5.7.1)

If Resend shows deliveries **bouncing** with a Gmail SMTP response like `550-5.7.1 ... Gmail has
detected that this message is likely unsolicited mail`, the fix that's actually in this codebase's
control has been applied: every digest email now carries a **`List-Unsubscribe` header** (+
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) pointing at a new, deliberately unauthenticated
Edge Function, `email-unsubscribe`. Gmail and Yahoo's bulk-sender rules (effective Feb 2024) treat a
missing one-click unsubscribe header as a strong spam signal **independent of whether your sending
domain's SPF/DKIM/DMARC is already correctly verified in Resend** — this is one of the single most
common causes of exactly this rejection message, even at very low send volumes, and it's a pure code
fix (deploy the two functions and set the one new secret above; nothing to change in Resend's own
dashboard).

**What this can't fix, stated plainly**: a brand-new sending domain has no reputation history with
Gmail yet, and Gmail's spam classifier weighs that alongside headers and content. If bounces continue
after the List-Unsubscribe fix is deployed, that's most likely domain/IP reputation still warming up —
Resend's own Domains tab shows DMARC alignment status, and sending a smaller, steady volume for the
first couple of weeks (rather than a burst) is the standard way a new domain earns trust with Gmail.
This isn't something a code change can shortcut.

**Not yet verified against a live Resend account** — same honest caveat as every other feature in this
app that needed a real outbound call and couldn't be fully tested from this session. If a send fails,
the error is whatever Resend's API returned, visible both in the "Trigger Emails Now" toast and in the
Edge Function's own logs (Supabase Dashboard → Edge Functions → Logs).

## Calendar Events

A general-purpose personal calendar entry, added directly from the **Calendar** page's new **"+ Add
Event"** button — Birthday / Anniversary / Reminder / Important Date / Countdown / Event / Custom,
each with its own title, date, an optional "repeats every year" flag (for Birthday/Anniversary-style
entries), free-form notes, and its own **advance reminder offsets** (e.g. `7, 3, 1, 0` days before).
Shown in green on the month grid and in the day-detail panel (click an event there to edit or delete
it); a new **Events** chip in the type filter row isolates them from deal/recurring activity.

This is separate from Contacts' own **Important Dates** (which are tied to a specific contact) — a
Calendar Event isn't attached to anyone, for things like your own anniversary, a trip countdown, or a
one-off reminder. Reminders fire through the same unified `notifications` table as everything else
(`fn_generate_calendar_event_reminders()`, folded into the existing 15-minute cron job) — a
`recurring_yearly` event matches by month/day every year; a one-off event matches its exact date once.

## Audit History Toggle

**Settings → Audit History** (admin only) is a single enable/disable switch for the `audit_row_change()`
trigger that backs every entry in Audit History — Deals, Payments, Payment Schedule, Reinvestments,
Recurring Items, and Recurring Occurrences all funnel through this one function. Disabling it stops
**future** growth of `audit_logs` if that table's size becomes a concern; it does not delete rows
already written; the spec's own "maintain audit history" rule still applies to everything logged
before you turned it off.

## Web Push Notifications

Real, near-instant browser notifications — works even when the app tab isn't open (as long as the
browser itself is running), unlike Email Notifications' digest model. Turn it on per-device in
**Settings → Push Notifications → Enable on This Device** (a browser permission prompt appears; each
device/browser is its own subscription, so a phone and a laptop are enabled separately).

**New infrastructure**: `supabase/functions/send-web-push/`, using `npm:web-push` (Supabase's Deno
runtime supports `npm:` specifiers directly, so this needed no hand-rolled VAPID/crypto code) to send
one push per pending notification, immediately — not batched like the email digest, since immediacy
is the whole point of push.

```bash
supabase functions deploy send-web-push
supabase secrets set VAPID_PUBLIC_KEY=BOomucASX8r5R122VlqGSyB5QG5H3PlyqVgRQxOzgBRwi7Cggt0WzQyWZh8JWxqQ2bzlw2LpwxO_A4RSeMxKeR8
supabase secrets set VAPID_PRIVATE_KEY=svUPm_umRuezZc_Rts64qccpNbPYIhIIMaWhbZCL8J4
supabase secrets set VAPID_SUBJECT=mailto:you@example.com
```

These are a **real, freshly generated P-256 key pair** — not placeholders. This machine has no
Node.js, so `web-push generate-vapid-keys` wasn't an option; a short Python script using the
`cryptography` package generated them directly. The public key is also hardcoded in
`web/js/lib/push.js` (same "safe to be public" status as the Supabase anon key) — if you ever
regenerate a new pair, update it in both places.

**Automatic delivery — this is a one-time Dashboard step, not something a code change can do.** If
you're only ever seeing pushes after clicking "Trigger Push Now" in Settings, it's because this step
hasn't been done yet, not a bug — the app has no way to run anything on a schedule by itself (no
`pg_net`/Vault, see every other Edge Function's own header comment for why). Two ways to close this,
and it's worth doing **both** — one for instant delivery, one as a safety net:

1. **Instant, on every new notification (recommended)** — a Database Webhook, which fires the moment a
   row is inserted into `notifications`, rather than waiting for a periodic sweep:
   - Supabase Dashboard → **Database → Webhooks** → **Create a new hook**
   - Name: `push-on-notification`. Table: `notifications`. Events: **Insert** only.
   - Type: **Supabase Edge Function**. Edge Function: `send-web-push`. Method: `POST`.
   - Save. From now on, every new notification triggers a push within seconds — no polling delay.
2. **Daily safety net (catches anything the webhook above ever misses)** — Dashboard → **Database →
   Cron Jobs** → **Create a new cron job**, pointed at `send-web-push`, schedule `0 8 * * *` (once a day
   at 8am UTC, or any time you prefer) — same Dashboard-native mechanism `gold-price-fetch` already
   uses. Safe to call even when there's nothing pending; the function just does nothing that run.

Both call the exact same function with no parameters, so there's no risk of double-sending — the
function only ever processes notifications where `push_sent_at is null`, so a webhook-triggered run and
a cron-triggered run landing close together just race to mark the same rows sent once, harmlessly.

**Not yet verified against real push delivery via the webhook path specifically** — the manual "Trigger
Push Now" button already reaches real devices per your own testing, so the function and VAPID keys
themselves work; only the trigger mechanism above is new and needs a first live confirmation.

## Family/Peer Portfolio Sharing

Lets a specific other person (a spouse, a family member) **view** — never edit — one person's
portfolio, without being admin themselves. Admin manages this directly: **Admin → Shared Portfolios**
— pick a user from the dropdown to start sharing their portfolio, add/remove Viewer members, and flip
the on/off switch per portfolio without losing the membership list.

This finally wires up `shared_portfolios`/`portfolio_members`, which have existed since the very
first migration but were explicitly left unconnected to any other table's RLS. A member with active
access sees a new **Shared With Me** nav item (only appears when there's actually something to see)
— a lightweight, read-only summary per shared owner, reusing the Admin page's own portfolio-detail
modal rather than retrofitting every view in the app to support "viewing as someone else."

**Scope**: Viewer-only this pass — the schema has an `Editor` role for later, but giving a second
person write access into someone else's deal/payment CRUD flows is a materially bigger change than
"let them see it," which is what was actually asked for.

## Admin: User Management

**Admin → Manage Users** can now create, deactivate/reactivate, and permanently delete accounts —
previously this only happened by hand in the Supabase Dashboard.

- **+ Add User**: enter an email (and optionally a name); a temporary password is generated and shown
  **once**, with a copy button — relay it to the new user yourself (text/WhatsApp/in person). No
  dependency on Supabase's own email deliverability (low free-tier limits, and Resend isn't configured
  as its SMTP provider).
- **Deactivate / Reactivate**: the default, fully reversible action — blocks sign-in via Supabase
  Auth's own ban mechanism, keeps every row that user ever created.
- **Delete Permanently**: a separate, harder-to-reach action gated behind typing the user's email to
  confirm. This is genuinely irreversible — it cascades (via this schema's existing foreign keys) to
  erase every deal, payment, contact, and message that user ever created. Deactivate unless you're
  certain.

**New infrastructure**: `supabase/functions/admin-user-management/`, the one function in this project
that touches `auth.admin.*` — it re-verifies the caller is an admin on every single call (a separate,
anon-key client built from the caller's own session token) before ever constructing a service-role
client, and never returns anything service-role-flavored to the browser.

```bash
supabase functions deploy admin-user-management
```

No extra secrets needed — only the three every Edge Function in this project gets automatically.

## Database Health

**Admin → Database Health** — every table's estimated row count (`pg_stat_user_tables.n_live_tup`, a
fast planner estimate, not a full table scan) and actual disk size (`pg_total_relation_size`), sorted
largest first, with empty tables visibly flagged. Use this to decide what's actually worth archiving
or clearing, without leaving the app to dig through the Supabase Dashboard's own Database section.
No "last used" column — Postgres doesn't track per-table last-access time by default, and that's a
distinct, heavier feature than what this answers.

## Data Export

Every core view (Deals, Recurring Investments, Contacts, Gold Purchases, Notes) has its own
**↓ Export** button — downloads just that section as an Excel file. **Settings → Data Export → Export
All My Data** bundles everything you have access to (those sections plus Payment Schedule, Payments,
Documents, Goals, Tax Records, Audit History, and Import History) into one workbook, one sheet per
section.

100% client-side, using the same `xlsx` library already loaded for the Import wizard (just run in
reverse — `json_to_sheet` instead of `sheet_to_json`) against data you already have RLS-scoped access
to. No new backend, no new Edge Function.

## Benchmark Comparison

**Analytics → Benchmark Comparison** plots your portfolio's lifetime realized ROI against Nifty 50 /
Sensex's % change over a selected period (1Y/3Y/5Y/All) and a flat FD reference rate — so a return
number has real-world context instead of standing alone.

**Data source**: the unofficial Yahoo Finance chart endpoint
(`query1.finance.yahoo.com/v8/finance/chart/^NSEI` / `^BSESN`) — confirmed live while building this
(real daily history, no API key needed), the same endpoint every free "yfinance-style" Nifty/Sensex
script relies on. It's **unofficial, not a documented/guaranteed-stable API** — flagged plainly, same
honesty as every other externally-sourced number in this app. The FD line has no clean free live-rate
source either, so it's a simple admin-editable assumption (**Settings → Benchmark Reference Rate**,
admin only), never presented as live.

**Honesty note on the comparison itself**: "My Portfolio" is your *lifetime* realized ROI, not scoped
to the period chip above — there's no per-period breakdown of realized returns yet, and pretending
otherwise would be misleading. Nifty/Sensex/FD genuinely are scoped to the period selected.

```bash
supabase functions deploy benchmark-fetch
```

No secrets needed. Schedule it daily via a Supabase Dashboard Cron Job (Database → Cron Jobs), same
pattern as every other Edge Function here; a manual **↻ Refresh** button on the Analytics panel works
too, from your own session.

## Visits & Login Analytics

**Admin → Visits & Logins** — logins today/this week, unique users, top browser, and a table of recent
sign-ins (approximate location, browser, OS, device) — visible **only** to admin; no regular user can
query this table at all, by RLS design.

**Consent, and a deliberate departure from the original request worth stating plainly**: the first
time anyone signs in, they're asked once whether to log approximate location/device with their
sign-ins (changeable later in Settings → Privacy & Contacts). The original request was "if consent is
declined, collect the available information anyway" — that defeats the point of asking, so **that is
not what this does**. A decline still logs the bare fact that a sign-in happened (so "logins today"
stays accurate), but never IP, location, or device — there is no server-side fallback path that
collects them regardless of the answer. If the non-compliant version is genuinely wanted, that's a
deliberate reversal of `supabase/functions/log-login/`'s own logic, not a bug to report.

```bash
supabase functions deploy log-login
```

No secrets needed — IP comes from the request itself (Supabase's edge network sets it), and the
geo-lookup (`ipapi.co`, keyless free tier) is best-effort: a failed lookup never blocks the sign-in
from being logged, it just logs without a location that time.

### Troubleshooting: no rows ever show up in Visits & Logins

The function's own Function Logs panel only ever showed `booted`/`shutdown` lines and nothing else —
that was a real gap (nothing in the function ever called `console.log`/`console.error`, so even a
genuine failure was invisible there), now fixed: it logs a clear success or failure line on every
invocation. Redeploy (`supabase functions deploy log-login`) to pick that up, sign in again, and check
Function Logs — it'll now say either `log-login: recorded sign-in for user ...` or a specific error.
A few things worth checking directly if it's still empty after that:
- Run `select count(*) from login_events;` in the SQL Editor — if it's `0`, the function isn't
  successfully inserting (check the new log line above for why); if it's `> 0`, the write is working
  and the gap is on the Admin page's read side instead (confirm your own account has
  `profiles.is_admin = true`).
- The frontend call (`App.api.logLogin`) deliberately never surfaces a failure to the signed-in user
  (`.catch(() => {})` in `app.js`) — this is intentional (a broken analytics call should never block
  someone from using the app), but it does mean the browser console won't show anything either; the
  Edge Function's own logs are the only place to look.

## Blog / Knowledge Sharing

A new **Blog** nav item — any signed-in user can post or comment, everyone can read, same open-to-
everyone visibility as Community Discussion. Deliberately plain text (no WYSIWYG, no image uploads) —
same simplicity level as Notes and Community already in this app. Posts support an optional category
and comma-separated tags; admin can delete any post/comment for moderation, same as Community's own
oversight model.

## Expenses & Projects

A brand-new, deliberately generic **Project → Category → Budget → Transaction → Vendor → Documents**
engine (`031_expense_projects.sql`) — not a "Home Expenses" tab. Home Construction is just the first
project; Wedding, Travel, Education, Vehicle, or any custom-named project work the same way, because
project type is data, not code.

- **Unlimited projects**, each with its own categories (a self-referencing table — a "sub-category"
  is just a row with `parent_category_id` set), per-category budgets, and an optional starter-category
  seed on creation (a client-side lookup for 9 suggested project types; anything else, including a
  fully custom name, starts empty).
- **Dashboard-first** navigation (Dashboard / Projects / Transactions / Budgets / Vendors tabs):
  KPI cards, Category Distribution / Debit vs Credit / Monthly Spending / Budget vs Actual charts,
  expense analytics (avg daily/monthly, highest expense, top category/vendor, cash vs digital split),
  budget-overrun banners, and a Project Comparison table once you have more than one project.
- **Transactions** carry the full field set from the spec: payment method, vendor, invoice number,
  payment status (incl. **Partially Paid**), an optional link to a vendor **Advance** (the full
  transaction amount is treated as drawn from that advance — not a separate partial-payment concept),
  a **Credit** type with its own reason taxonomy (Refund / Advance Return / Discount / Received From
  Someone / Material Return / Other) tracked independently rather than as a negative expense, and an
  optional foreign-currency section (`amount` is always the base/INR value so every chart/KPI works
  unchanged; the foreign amount/currency/rate are extra record-keeping fields, entered manually — no
  live FX rate lookup, same honesty pattern as the FD reference rate). Full CRUD plus **Duplicate**
  (clones a transaction into a pre-filled new entry, including its foreign-currency fields if any).
- **Custom Fields** (`expense_project_custom_fields` / `expense_transaction_custom_values`) are the
  single most important piece architecturally: they're what makes a project type's specialized fields
  (Home Construction's Floor/Room/Material/Quantity, Wedding's Guest Count/Venue, ...) **configuration
  you add per project, not a column anyone had to write code for**.
- **Vendors** get their own table (GST/bank-UPI fields Contacts doesn't have), with an optional link to
  an existing Contact; **Advances** are tracked per vendor, with "remaining" computed from the
  transactions applied against them.
- **Bill/receipt attachments** reuse the existing `documents` table, Storage bucket, and RLS as-is —
  just one more nullable FK (`documents.expense_transaction_id`). Attach or remove a file directly from
  a transaction's edit screen (only available after the transaction is first saved, since a document
  needs something to attach to).
- **Excel import** extends the existing wizard with a sheet type that's detected **by content, not just
  by sheet name** — if no sheet is literally named "Expense," any unclaimed sheet whose header row
  contains a Dr/Cr-style column is treated as one. Columns auto-map (S.No is ignored; Date/Item/Amount/
  Debit-Credit/Description map directly; Category/Project/Vendor/Payment Method/Invoice/Notes are
  optional) and go through the same validate-before-import preview as every other sheet type. Export
  (per-project and "Export All") extends the existing `xlsx`-based `exportData.js`.
- **Calendar** gets a fourth overlay type (an "Expenses" filter chip, orange day markers, and a
  🟢/🟡/🔴 status dot per transaction in the day-detail view) on the same unified calendar every other
  module already shares — not a separate calendar page.
- **Budget-overrun alerts** reuse the existing notifications engine exactly like every other alert in
  this app (`fn_generate_expense_budget_alerts()`, folded into the 15-minute cron job and "Run
  Automation Now") — a category crossing 90%/100% of its own budget fires a real notification with the
  established `dedupe_key` idempotency.
- **Permissions** reuse `private.has_portfolio_view_access()` (built for Family/Peer Portfolio Sharing)
  as one more OR-clause, so a Viewer who can already see your other portfolio data can see a shared
  expense project too, for free — no new sharing mechanism.

**Deliberately deferred** (see "Known limitations" below for the full reasoning): OCR/AI Bill Entry
and an AI Expense Assistant, month-end closing/locking, a dedicated Construction Progress tracker,
and PDF export.

## Live Cross-Device Portfolio Sync

The first use of Supabase Realtime on the app's own financial data — every earlier use of Realtime in
this app (chat, notifications, calls, community/ticket messages) was social, not portfolio content.
Edit a deal on your phone; your laptop's already-open Dashboard or Deals list updates within a second
or two, with no manual reload. Covers Deals, Payment Schedule, Payments, Recurring Items, Recurring
Occurrences, Gold Purchases, and Expense Transactions — one Realtime channel, RLS-scoped to your own
rows, subscribed automatically the moment you sign in.

A change made by a genuinely different session shows a small "Your data was updated elsewhere" toast;
a change you just made yourself in this same tab is recognized as an echo (Postgres Changes broadcasts
to every matching subscriber, including the one that made the write) and doesn't toast a second time —
the view still refreshes either way, since a redundant refresh is harmless while a redundant toast
isn't. No new Edge Function or migration needed for this — `subscribeToPortfolioChanges` in `api.js` is
the only new piece.

## Notification Delivery, by Type

**Settings → Notification Delivery, by Type** — a full type × channel (In-app / Email / Push) checkbox
matrix, `notification_type_preferences`. Uncheck every box for a type (e.g. "Recurring Reminder") and
it generates nothing on any channel for you — the underlying `notifications` row is still written
(nothing is missing from Audit History or that type's own detail view), it simply never reaches the
bell, a digest email, or a push notification. Leaving a type untouched keeps every channel enabled,
today's existing behavior — nothing changes for anyone who never opens this panel.

Enforced at the two delivery points (`send-notification-emails`, `send-web-push`) plus the three
in-app touch points (the bell badge count, the notification panel list, and the realtime toast) —
never by touching the ~19 places across 9 migration files that actually generate a notification. A
suppressed email/push is still marked as sent so it's never silently retried forever once you turn
that channel back on for a type.

If you already deployed `send-notification-emails`/`send-web-push` on a live project, redeploy both
(`supabase functions deploy send-notification-emails` / `send-web-push`) to pick up the new per-type
check - the running version otherwise won't know this table exists yet.

## Clear My Data / Clear Entire Portfolio Data

Two intentionally hard-to-reach "Danger Zone" actions:
- **Settings → Clear My Data** (any user) — permanently deletes every deal, payment, recurring item,
  gold purchase, expense, contact, note, and document you own, plus the actual files in the
  `documents` Storage bucket under your folder. Community, Blog, Support Tickets, Chat, and any
  Shared Portfolio are deliberately untouched, even though some of those tables carry your `user_id`
  too — deleting a conversation another member is still reading, or a shared portfolio a Viewer still
  has open, would be a correctness bug, not a feature. Your account and every setting/preference stay
  intact; only data is cleared. Requires typing the exact phrase `DELETE MY DATA` to confirm.
- **Admin → Clear Entire Portfolio Data** — the same table list, for **every user on the project at
  once**. No account is deleted, only data. Requires typing the longer phrase
  `DELETE ALL PORTFOLIO DATA`, deliberately more friction than the personal version given the blast
  radius.

Both are backed by SECURITY DEFINER-free/gated SQL functions (`fn_clear_my_data()`,
`fn_admin_clear_all_data()`) in `032_ui_and_notification_preferences.sql` — there is no undo for
either action.

## Customize Sidebar

**Settings → Customize Sidebar** — reorder any section within its own group (up/down, not
drag-and-drop — functionally identical, far less error-prone to get right), hide sections you don't
use, or switch the whole sidebar to icon-only (compact) mode. Saved to `profiles.ui_preferences`, so
it follows you across devices rather than resetting per-browser.

Hiding a section only removes its **link** — every view stays fully reachable by its URL/hash
regardless of what's hidden, so a notification click-through or a bookmark into a hidden section still
works correctly. This is a real constraint worth stating: an earlier version of this exact sidebar
render function had a bug where rebuilding the wrong part of the DOM caused a blank-screen regression
(see the fix committed this same batch) — Customize Sidebar was deliberately built to only ever touch
the nav links, never the underlying view containers, to avoid reintroducing that class of bug.

**Not built this pass**: the equivalent reorder/hide treatment for Dashboard's own KPI/panel cards.
`dashboard.js` builds its panels as one large inline template rather than from a reorderable list of
panel objects — retrofitting that architecture safely is a bigger, riskier change than the sidebar
(which already had a clean, data-driven `NAV_STRUCTURE` to work from) and didn't feel right to force
into this batch. Worth a dedicated pass if this is wanted.

## Smaller quality-of-life additions

- **Delete Deals / Recurring Items** — both were creatable, editable, and (for deals) closable, but
  never deletable. Both now have a delete action (row icon + inside the detail modal's Manage tab for
  recurring items), gated behind typing the item's exact name to confirm. A deal with recorded payment
  history can't be deleted — `payments.deal_id` is `on delete restrict` on purpose, this app's
  "never lose financial history through a side effect" rule — the UI catches that and points you at
  editing the deal's Status to `CLOSED` instead.
- **Payments filters + External Deal ID** — the Payment Schedule and Receipt Ledger tabs now have a
  Month/Year filter (independent of each other and of Deals/Dashboard's own filter bar), and both
  tables — plus the Deals list — now show External Deal ID as a real column, not just a searchable
  field captured on create.
- **Interest Calculator, now with both Monthly and Yearly modes** — a radio toggle switches between
  Principal + Months + a Monthly Rate% (matching how P2P/gold-scheme/chit-fund rates are actually
  quoted, e.g. "1.75% per month") and the traditional Principal + Years + an Annual Rate% shape,
  each with its own quick-pick chips and a full period-by-period Simple vs. Compound breakdown table.
  (An earlier pass replaced Yearly with Monthly instead of adding Monthly alongside it — both are back
  now, together.) The page also gained a second tab, **EMI Calculator** — the standard reducing-
  balance loan formula (Loan Amount, Tenure in Years, Annual Rate%) with a full month-by-month
  amortization schedule (EMI/Principal/Interest/Balance per month).
- **Expense import now auto-creates Projects and Categories** — previously the import wizard required
  at least one project to already exist and left an unmatched category blank; an unmatched Project or
  Category name in the sheet is now created automatically (mirrors the existing Vendor auto-create),
  so a full expense history can be imported without pre-creating anything by hand first.
- **Minimal, section-aware animations** — Dashboard/Gold/Expenses KPI cards now stagger in on load
  (distinct from the app-wide fade already used for view/tab switches), and quick-pick chips
  (Calculator, filters) get a subtle press/select nudge. Every animation in the app, old and new, now
  respects `prefers-reduced-motion` — previously none of them did.

## Help & Assistant, User Support & Feature Suggestion Hub

Extends the original "Message to Us" ticket system into a full Help & Support experience, reachable
from both the Login screen (before anyone has signed in) and from inside the app — plus a completely
separate Feature Suggestions system with voting and a shared roadmap, deliberately never mixed into
the same inbox as support tickets.

**Login screen → 🤖 Need Help?** A lightweight pre-login modal for exactly the things someone without
a working account can actually need: Cannot create account, Forgot password, Email verification issue,
Contact administrator, or a direct link into "Try Demo Mode" (already fully solved — it needs no
account at all). **Forgot Password now does something real** — it sends an actual Supabase password
reset email (`resetPasswordForEmail`) rather than only ever being a ticket category; clicking the link
in that email brings you back to a new "Set New Password" screen. If that still doesn't get someone
back in, or for the other three options, the request becomes a real ticket via a new, deliberately
narrow `fn_submit_guest_ticket()` SECURITY DEFINER function — the **only** place in this entire app
that accepts an unauthenticated write, and even then only a ticket (name/email/message, one of three
categories, a 5-per-day-per-email rate limit) with no read-back capability (there's no account to log
into to check on it — admin follows up by email/phone directly, per the ticket's own "Contact user"
workflow). It returns a real reference number (e.g. `TKT-00042`) and shows up in Admin's queue exactly
like any other ticket.

**Inside the app, "Help & Support"** (same nav slot as the old "Message to Us") is now four tabs:
- **Get Help** — the full structured category grid (Account & Login / Portfolio Support / Suggestions
  & Ideas / Other) from the spec's own design. Picking a category first searches existing Blog posts
  by keyword and shows anything relevant ("Did this answer your question?") before ever opening the
  ticket or suggestion form — a deterministic keyword search, deliberately not a conversational AI
  (this app's "no live model call" precedent, same honesty as AI Insights and the Interest
  Calculator's portfolio comparison).
- **My Requests** — your own ticket history and threaded replies (unchanged from before, now with a
  category badge, and a one-time star-rating prompt the first time you open a ticket that's just been
  marked Resolved).
- **My Suggestions** — every idea you've personally submitted, with its current status.
- **Roadmap** — every suggestion from every user, sorted by vote count, filterable by status. Typing a
  new suggestion's title runs a live keyword-overlap check against existing titles and offers "support
  this idea instead" if something similar already exists, instead of creating a near-duplicate.

A **💡 Suggest Improvement** button on Gold Intelligence and Expenses & Projects (the two most complex
feature pages) opens the New Suggestion form with `related_feature` already filled in — you only have
to describe the idea, the context is captured automatically.

**Admin gets two new panels** (Admin page, right after Manage Users): **Support & User Queries** (stat
cards by status/priority, an Unassigned/Assigned-to-Me/All filter, and a detail view with
category/priority/status/assignment editors plus an **Internal Notes** panel — admin-only commentary
that a ticket's own owner can never see, verified end-to-end, not just assumed from the RLS policy)
and **Suggestions & Ideas** (stat cards by lifecycle stage, the same Internal Notes pattern, status
changes that notify the suggestion's own author).

**Database**: `034_help_support_suggestions.sql` — extends `support_tickets` with category/priority/
assignment/first-response-time/resolution-rating/guest fields and a richer 9-state status lifecycle
(existing `'Open'` rows are remapped to `'New'` before the constraint changes, so this is safe to run
against a live project with real tickets already in it); adds `ticket_internal_notes` and
`feature_suggestions`/`suggestion_internal_notes`/`suggestion_votes` (plus a `v_suggestion_vote_counts`
view) as entirely new tables. `feature_suggestions` is readable by every signed-in user (`using
(true)`, same openness as Community/Blog) so voting and the roadmap work; its admin-only notes are a
genuinely separate table, not a column, specifically because a bare column on an openly-readable table
would leak admin commentary to everyone — the same class of mistake `profiles.is_admin` already warns
about elsewhere in this schema.

**Known limitation, stated plainly**: Demo Mode's mock doesn't simulate server-side trigger-driven
notifications (changing a suggestion's status in Demo Mode won't generate a real "Suggestion Status
Changed" notification) — the same pre-existing gap already documented for Gold price alerts and
Recurring reminders; the real Postgres trigger is unaffected and was reviewed for correctness, just
not executable without a live project.

## Accounts & Liabilities, and Net Worth

The first two items of the user's own strategic wishlist, built together — Net Worth is mostly
aggregation once Accounts & Liabilities exist as real data. One new nav item, **Net Worth** (in the
Insights group), with three internal tabs.

- **Accounts** — Bank, Cash, Wallet, and Investment-Account-as-a-holding-bucket balances, entered
  and updated manually (there's no bank feed or auto-reconciliation — same honesty pattern as this
  app's gold price and FD/FX reference rates). This deliberately does **not** re-track P2P/FD/bonds
  (already Deals) or gold (already Gold Purchases/Gold Scheme) — Net Worth pulls those in directly
  from their own modules rather than duplicating them here.
- **Liabilities** — Credit Card, Personal Loan, Home Loan, Vehicle Loan, and Other Loan outstanding
  balances. This is a real, deliberate distinction from Recurring Investments' own `'Credit Card'`
  item type: Recurring tracks "confirm this month's bill payment" (a repeated obligation);
  a Liability tracks "how much do I currently owe in total on this card" (a running balance). The
  two are complementary and never merged — no due-date reminders are built for Liabilities here.
- **Net Worth** — computed **client-side**, not from a new multi-table SQL view: Accounts (sum of
  active balances) + Deals (`v_deal_metrics.total_outstanding` per deal) + Gold (Gold Scheme holdings
  + standalone purchases × the same latest 22K price Gold Intelligence's own dashboard card uses) −
  Liabilities. KPI cards, an asset-allocation doughnut, a liability ratio, and a historical line chart
  are all on this tab, plus a compact card on the main Dashboard (right after the Gold panel) linking
  through to the full page.

**History** is a lightweight daily snapshot (`net_worth_snapshots`), not a preview of a future "Time
Machine" feature (still queued, separately, as its own future addendum — full point-in-time
reconstruction of portfolio detail is a materially bigger feature than a daily aggregate number).
The client upserts one row per `(user, day)` the first time you open the Net Worth tab that day —
revisiting the same day updates that row rather than creating a duplicate — plus a manual **"Save
Snapshot Now"** button for whenever you want an extra checkpoint.

**Database**: `035_accounts_liabilities_net_worth.sql` — `accounts`, `liabilities`, and
`net_worth_snapshots`, all with the same three-way RLS shape (owner full CRUD, admin read-only, a
Family/Peer Portfolio Sharing Viewer read-only) as Deals/Gold Purchases/Expense Projects; all three
are wired into `SELF_SCOPED_TABLES`, `fn_clear_my_data()`, and `fn_admin_clear_all_data()` from day
one. Accounts and Liabilities also get their own Export buttons (and are included in Export All).

## Cash Flow

The next item on the user's own wishlist, built the same way Net Worth was — pure client-side
aggregation over data this app already owns, no new SQL view. One new nav item, **Cash Flow** (right
after Net Worth in Insights), pulling together Deal Payment Schedule/Payments, Recurring Investments,
Expense Transactions, and Accounts into one picture that no single existing view showed together:

- **This Month** strip: Received (Deal payments), Expected (Deal schedule), Recurring Confirmed vs.
  Yet to Confirm, Expenses (net Debit − Credit), and one combined **Net Cash Movement** figure
  (Received − Recurring outflow − Expense net) — every Recurring occurrence is treated as an outflow
  (money leaving your account, whether it's a bill or an investment contribution), never mixed in as
  income.
- **6-month trend chart** — Inflow (Payments) vs. Outflow (Recurring + Expenses), the same month-
  bucket-loop pattern Expenses & Projects' own dashboard already uses, generalized across the whole
  portfolio instead of one project.
- **Upcoming (Next 7/30/90 Days)** — Deal schedule and Recurring due-dates combined into one number.
- **Financial Year** strip — Received vs. Outflow for the current and previous FY (using the same
  `financial_year_start_month`/`_day` profile setting every other FY-aware view already respects).
- **Available Cash** — the sum of your active Accounts' current balances, linking straight through to
  Net Worth's Accounts tab to manage them.

`sumWhere()` and `fyBounds()` — originally small local helpers inside the Dashboard's own Cash Flow
panel — moved into `App.utils` so both places compute "this month received"/"current FY" the exact
same way; the Dashboard panel's own numbers are unchanged, just now sourced from the shared functions.

`cash_transactions` (a manual deposit/withdrawal ledger table that's existed since the very first
migration, for a still-unbuilt "Idle Cash Tracker") is deliberately **not** used here — it's a
different, separate concept from projecting cash flow off Deals/Recurring/Expenses, and remains
unwired until that feature is built on its own terms.

## Reconciliation Center

"Accounts vs. expected Payments/Recurring amounts" from the user's own wishlist — built as two
things, not one, since a real Bank Reconciliation matcher already existed live inside Payments:

- **Bank Reconciliation, extended, not duplicated.** The existing "Bank Reconciliation" tab
  (`payments.js`, unchanged in every other way) now suggest-matches an uploaded bank statement
  transaction against **either** a Deal payment-schedule row **or** a Recurring occurrence, not just
  Deals as before — same fuzzy amount/date scoring formula, just run over both candidate pools.
  Confirming a Recurring match calls the same `confirmRecurringOccurrence` path Recurring's own
  Confirm modal uses (picking `INVESTED` vs. `PAID` based on the item's type, same convention),
  records the match, and marks the bank transaction resolved — no separate matcher UI to maintain.
- **A new "Reconciliation Center" nav item** (Insights group) with a genuinely new **Balance Check**:
  a portfolio-wide sanity check comparing what your Accounts *should* hold (opening balances +
  Payments received − Recurring confirmed outflow − Expense net) against what they actually hold
  today. This is deliberately **not** a per-account reconciliation — Payments/Recurring/Expense rows
  aren't linked to a specific account (adding that link would mean altering three live financial
  tables), so a large variance is framed honestly as "you probably forgot to log something," not a
  precise per-account discrepancy. A second card links straight through to Payments' Bank
  Reconciliation tab for actual transaction-level matching.

**Database**: one small migration, `036_reconciliation_recurring_match.sql` — a single nullable
`payment_matches.recurring_occurrence_id` column, mirroring the table's existing nullable `deal_id`/
`payment_id` columns.

## Backup & Disaster Recovery

Extends the already-shipped "Export All My Data" (now renamed **Backup & Disaster Recovery** in
Settings) with a genuine **Restore** path — read a previous export back in and rebuild your data from
it. **Restore is additive only**: it adds new rows, it never updates or deletes anything already in
your account. It exists to rebuild an empty or damaged project after real data loss, not to merge into
a project that still has your data — doing that will create duplicates, and the UI says so plainly
before you can run it.

- **Two small export completeness fixes first**: `Platforms` and `Expense Advances` are now their own
  export sections (they weren't before) — without Platforms, a restored Deal would have no way to
  resolve its platform link at all; Expense Advances was simply missing.
- **Restore reads the exact same column names Export wrote** — no column-mapping UI needed (unlike the
  general Import wizard, which has to guess at an arbitrary user spreadsheet's headers). It processes
  sections in a fixed dependency order (Platforms → Deals → Payment Schedule → Payments → Recurring
  Items → Recurring Occurrences → Gold Purchases/Accounts/Liabilities → Contacts → Expense Projects →
  Expense Vendors → Expense Advances → Expense Transactions → Notes/Goals/Tax Records), remapping each
  parent's old numeric id to its newly-assigned id before inserting any row that references it.
- **`Documents`, `Audit History`, and `Import History` are deliberately excluded**, shown in the
  checklist as permanently disabled with a one-line reason each: Documents' actual files live in
  Storage, not in the export, so restoring metadata-only rows would dangle; Audit History is
  system-write-only by design and restoring old entries as "new" would misrepresent when they actually
  happened; Import History is a log of past import runs, not portfolio holdings. `Expense Categories`
  isn't its own section either, so a restored Expense Transaction loses its category assignment (a
  nullable column — an acceptable, disclosed gap) while everything else about it is preserved.
- **One new API primitive, `restoreInsertRow`**, is the only thing Restore ever calls — a raw insert
  with zero business-logic side effects, deliberately skipping what the friendly `createDeal`/
  `createRecurringItem`/`recordPayment`-style functions do for fresh manual entry (auto-generating a
  payment schedule, auto-generating future occurrences, recomputing deal state via an RPC) — the
  exported row already reflects whatever those side effects produced the first time, for real, in the
  past, so re-running them during a restore would be wrong, not just redundant.

## Time Machine

The last item of this batch, and the one that needed the least new infrastructure — Net Worth's own
`net_worth_snapshots.breakdown` was already a flexible `jsonb` column, so Time Machine is built by
simply writing a richer object into it. **Zero new migration.**

- `computeNetWorth()` now returns per-row holdings detail alongside its existing totals — each active
  Account's balance, each active Liability's outstanding amount, each Deal with outstanding principal,
  and the Gold total — not just the four aggregate numbers the column started with. Both places that
  write a snapshot (the daily auto-save and the manual "Save Snapshot Now" button) automatically pick
  up the richer shape with no other change.
- A new 4th tab on the Net Worth page (no new nav item): **Time Machine**. Pick a past date (only
  dates you've actually saved a detailed snapshot for are selectable — a plain date picker would imply
  precision that doesn't exist) and see that exact point-in-time picture, either against **Today** or
  against a **second past date** of your choosing. Each of Accounts/Deals/Liabilities gets its own
  before/after/delta table, row-matched by id so an account or deal added or removed between the two
  dates shows up as **Added**/**Removed**, not silently dropped from the comparison.
- **Stated plainly**: Time Machine has no resolution before Net Worth started tracking history, and
  none between two visits if you skip days — it reconstructs from saved snapshots, it doesn't replay
  history from first principles. Snapshots saved before this feature shipped only have the four
  aggregate totals (no row-level detail) and are correctly excluded from the date picker rather than
  shown with misleading empty tables.

## Automation Center

A user-configurable IF-condition-THEN-notify rules engine — **deliberately notify-only**, per an
explicit decision made before building it: a rule can never change a deal, recurring item, account, or
any other row unsupervised. It only ever creates a notification, exactly like every other alert
generator in this app.

Rather than a fully generic "any metric, any operator" query builder — a real dynamic-SQL injection
surface this app has never taken on anywhere else — Automation Center uses a **fixed catalog of six
rule types**, mirroring Gold Intelligence's own `gold_alerts` precedent (a table of per-user threshold
rows, evaluated by one cron function with a hand-written branch per type):

1. **Expense Budget %** — your own budget-used warning threshold (replacing the hardcoded 90%/100% in
   the existing budget alert), scoped to one project or all of them.
2. **Deal Payout Reliability Below** — alert when any deal's reliability score drops below a %.
3. **Recurring Consistency Below** — alert when any recurring item's consistency score drops below a %.
4. **Account Balance Below** — alert when a specific (or any) account drops below an amount — nothing
   in this app watched Accounts at all before this.
5. **Liability Rising Above** — alert when a specific (or any) liability's outstanding balance rises
   above an amount — catches a creeping credit card balance, for example.
6. **Net Worth Change %** — compares your latest saved Net Worth snapshot against one from N days ago;
   fires when the change is at or beyond your threshold. This reads your *saved* `net_worth_snapshots`
   row, not a live recomputation — it's only as fresh as your last visit to the Net Worth page, since
   nothing currently re-snapshots it automatically. Stated plainly in the rule's own description.

**Not included this pass, stated plainly rather than silently attempted**: Cash Flow-based rules (Cash
Flow has no persisted server-side data at all — it's computed entirely client-side) and a gold-
allocation-% rule (would mean porting the client-side gold-value formula into SQL, a real duplication-
of-logic risk). Both are clean, bounded follow-ups if wanted later.

New nav item **Automation Center** (Insights group): a rule list with pause/resume/delete, a "+ New
Rule" form (pick a type, fill in type-specific fields), and a "Recently Triggered" feed. Rules evaluate
on the same 15-minute cron cycle as every other alert in this app, and through the admin "Run
Automation Now" button.

## AI Portfolio Copilot

This app's **first live LLM API call** — stated as plainly as every other honesty disclosure here.
Ask a plain-English question about your own portfolio ("What's my net worth?", "How's my cash flow
this month?") and your chosen AI provider answers it, grounded only in real numbers already computed
by this app — never a live database connection the model queries itself, and never a number it invents.

- **Pick your own AI provider** — Settings gets an "AI Model Provider" panel (admin-only to change,
  visible to everyone) mirroring Gold Intelligence's own provider-selection design exactly:
  `ai_providers`/`ai_settings` (`039_ai_copilot_providers.sql`), a `kind`-branching Edge Function, and
  a generic "custom provider" slot for anything not built in. Two providers ship built in:
  - **Anthropic Claude** (`claude-sonnet-5`) — secret `ANTHROPIC_API_KEY`.
  - **Google Gemini (AI Studio)** (`gemini-2.5-flash`) — secret `GOOGLE_AI_API_KEY`. **Seeded as the
    default active provider**, since that's the key actually on hand for this deployment — the feature
    works out of the box once that one secret is set, no settings change needed first.
  - **Custom provider** — assumes an **OpenAI-compatible chat-completions API**
    (`POST {base_url}/chat/completions`, `Authorization: Bearer <secret>`) — the shape virtually every
    other free/open model host implements (Groq, OpenRouter, Together, Fireworks, a local Ollama
    endpoint). The Supabase secret holding a custom provider's key **must be named with a
    `COPILOT_CUSTOM_` prefix** — enforced at the database check-constraint level, re-validated
    client-side in the Add Custom Provider form, and re-validated again at runtime in the Edge
    Function, so a misconfigured custom provider can never be pointed at an unrelated secret.
  - Only the secret for whichever provider is **currently active** needs to be set — you don't need
    both an Anthropic and a Google key just because both providers are listed.
- **A hard daily cap of 20 questions per user**, unaffected by which provider is active — confirmed
  before building this feature, so a bug or heavy use can't run up unexpected API cost. The cap is
  enforced atomically in Postgres, checked *before* the Edge Function ever loads a provider or makes a
  call, so a rejected question costs nothing.
- **Context is assembled client-side**, not inside the Edge Function. Net Worth and Cash Flow have no
  server-side view or function backing them (both are deliberately client-side aggregation) — rather
  than reimplementing that math a second time in Deno/TypeScript (a real drift risk), the Copilot panel
  calls the exact same `computeNetWorth()`/`computeCashFlow()` functions those pages already use, plus
  the same summary/aggregate API calls (Portfolio Summary, Deal Metrics, Recurring Summary/
  Consistency, Gold Scheme Holdings, Expense Project/Category Summaries), and sends the result
  alongside the question. The Edge Function itself never queries anything beyond the usage-cap check
  and the active-provider lookup.
- **No conversation history is ever persisted** — each question is answered statelessly, kept only in
  the browser tab for the current visit. A deliberate, privacy-minimizing default: nothing here needs
  a permanent record of your free-text financial questions, and the usage counter already gives admin
  enough to audit volume.

New nav item **AI Portfolio Copilot** — a simple chat panel (question in, answer out), showing your
remaining daily quota, a plain disclaimer that the active provider only sees what's actually loaded
below it, and a small "via {Provider Name}" caption under each answer so it's never ambiguous which
model actually responded.

**Deploy** (first non-SQL step this feature needs, same as Gold Intelligence's own Edge Function):

```bash
supabase functions deploy ai-copilot
supabase secrets set GOOGLE_AI_API_KEY=...
# and/or: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
# and/or, for a custom provider added via Settings: supabase secrets set COPILOT_CUSTOM_yourname=...
```

**Unverified against a real API key, same honest caveat as every other external-call feature in this
app** — the SQL and the Edge Function are self-reviewed for correctness (Gemini's request/response
shape was checked directly against Google's own API documentation, not guessed), but neither provider
call could be executed against a live key in this session. Deploy it, set whichever secret(s) you
have, ask a question, and report back the first real response or error.

## Architecture, in one paragraph

Every piece of backend logic the spec asks for — derived financials, payment-schedule generation,
the payment-confirmation pipeline, nightly reminders, audit logging — lives in Postgres itself
(views, PL/pgSQL functions, triggers, and a `pg_cron` job), because there's no Node/Edge Function
server in this deployment to put it in instead. The frontend (`web/`) is deliberately plain:
`index.html` plus a small set of global-namespace `<script src>` files (no bundler, no ES modules,
no framework) so it keeps working from a double-clicked file or any static host. `web/js/data/api.js`
is the *only* file that talks to Supabase — every view calls through it rather than using
`supabase-js` directly.

## Smoke tests

After running the migrations, these confirm the core engine actually works, from the SQL Editor:

```sql
-- 1. Sign up two test users from the app first, then as each one (or via the SQL editor
--    impersonating each auth.uid()), confirm RLS isolation - each should only ever see their own:
select count(*) from deals;              -- should never show the other user's deals
select count(*) from payments;           -- same

-- 2. Create one ACTIVE deal per user with a maturity_date and Monthly frequency, then:
select public.fn_generate_payment_schedule(<deal_id>);
select scheduled_date, expected_interest, expected_principal, status
from payment_schedule where deal_id = <deal_id> order by scheduled_date;
-- dates should land on sensible monthly boundaries (Postgres clamps month-end automatically,
-- e.g. 31 Jan -> 28/29 Feb), and expected_total = expected_interest + expected_principal always.

-- 3. Record a payment against the first scheduled row and confirm the pipeline ran:
select public.fn_record_payment(<deal_id>, '<scheduled_date>'::date, <expected_total>,
  p_interest_amount := <expected_interest>, p_principal_amount := <expected_principal>);
select status, actual_payment_id from payment_schedule where id = <that_row_id>;  -- now RECEIVED_*
select current_principal, last_payment_date, next_payment_date from deals where id = <deal_id>;
select * from audit_logs where table_name = 'payments' order by changed_at desc limit 5;  -- populated

-- 4. Re-run the exact same fn_record_payment call again - it should fail with a unique_violation
--    on payments (dedupe_key), not create a second row. That's the idempotency guarantee.

-- 5. Manually run the nightly job once instead of waiting for 2am:
select public.fn_refresh_schedule_statuses();
select public.fn_generate_reminders();
select public.fn_generate_ai_insights();
select * from notifications order by scheduled_at desc limit 10;
select * from ai_insights order by generated_at desc limit 10;
```

## Verification performed on this build

The frontend was exercised view-by-view in a browser against an in-memory mock standing in for
Supabase (no live project was available while building this) — every one of the 16 views, the
4-step deal wizard, payment recording, the full Excel import pipeline (upload → auto-map → validate
→ preview → import → schedule generation), the reconciliation flow, voiding a payment, resolving a
reinvestment, and the notification center were driven end-to-end, not just read. That process
caught and fixed three real bugs before they'd have reached a live database:

- A race in `supabaseClient.js`'s session check that could clobber a just-completed sign-in with a
  slightly slower, now-stale "no session" answer.
- `<select>` fields bound to numeric ids (deal/platform pickers) were sending the id as a string
  (`"2"` instead of `2`) — harmless against a loose backend, but a real risk against a `bigint`-typed
  RPC parameter.
- Forms were sending explicit `null` for fields the user left blank, which defeats a Postgres
  column's `DEFAULT` (a default only applies when the column is omitted from the insert, not when
  it's explicitly `NULL`) — `deals.status` would have failed its `NOT NULL` constraint on a real
  database the first time someone created a deal without touching the Status dropdown.

What this testing could *not* cover: the actual SQL running against real Postgres features (RLS
policies, generated columns, triggers, `pg_cron`) — the mock doesn't simulate any of that, so the
smoke tests above are how to close that gap once you have a live project.

## Known limitations / deliberate scope cuts

These are called out here rather than left for you to discover — each is a considered choice, not
an oversight:

- **AI Insights (Section 37) are rule-based, not an LLM call.** `fn_generate_ai_insights()` fills
  templates from real aggregate queries (income trend, maturity concentration, platform
  concentration, overdue count) with the record ids behind each number saved alongside it. There's
  no server here to hold a model API key, and the spec's own requirement — "AI must not invent
  financial figures; every insight should be traceable to underlying records" — is satisfied more
  directly this way than an actual LLM call would.
- **Email and Web Push now deliver for real (see those sections above); WhatsApp/Telegram still
  don't.** Those two remain real columns and preference toggles with nothing behind them yet — each
  would need its own secret-holding integration (the WhatsApp Business API, a Telegram bot token) the
  same way Email now has Resend and Push now has `web-push`.
- **Community chat has no moderation.** Any signed-in user can post; there's no delete/report/block
  mechanism yet. Fine for a small, trusted group of friends/family; worth adding before opening this
  up more broadly.
- **Future integrations (Section 50)** — lender/platform APIs, open banking, SMS/email parsing,
  Google Calendar, accounting software — are `integration_configs` rows and a Settings screen, all
  starting "Not Connected." The spec asks to "design interfaces for" these, not to build working
  integrations against external providers with no credentials available.
- **Peer-to-peer shared/family portfolios (Section 3's own "may be added later") are now wired up,
  Viewer-only** (see "Family/Peer Portfolio Sharing" above) — `shared_portfolios`/`portfolio_members`
  finally have a membership check on the other core tables' SELECT policies, not just admin's own
  bypass. What's still deferred is the `Editor` role the schema already has columns for: giving a
  second person write access into someone else's deal/payment CRUD flows is a distinct, larger change
  than the read-only sharing that was actually asked for.
- **The Maturity Planner's reinvestment "decision"** (Reinvest/Withdraw/Partially reinvest/Keep as
  cash/Decide later) is stored in the browser's `localStorage`, not the database — it's provisional
  planning state about a deal that hasn't matured yet, not a financial record. Once principal is
  actually returned, the real `reinvestments` table (Section 16) takes over.
- **The nightly cron job runs on the database server's clock (UTC on Supabase)**, not per-user local
  time. For a personal/family-scale app this means a reminder can land a few hours off local
  midnight, never that it's silently skipped.
- **Deleting a deal that has documents but no payments** removes the `documents` metadata rows
  (cascade) but not the underlying files in Storage — a narrow edge case (deals with real payment
  history can't be deleted at all, per the non-negotiable "never delete financial history" rule) not
  worth a Storage-API-calling trigger for.
- **Voice/video calling is STUN-only, best-effort.** There's no TURN relay (that needs a paid/hosted
  TURN server this build doesn't include), so a call between two people on restrictive/symmetric-NAT
  networks can fail to connect — the phone/WhatsApp fallback buttons exist specifically for this.
- **Bank reconciliation matching (Section 23)** uses a simple heuristic (amount within 2%, closest
  date, among still-unresolved schedule rows) — good enough to suggest matches, not a claim of
  certainty; every suggestion still requires an explicit Confirm.
- **Gold Intelligence's live price feed, Email Notifications, Web Push, Benchmark Comparison, and
  Visits & Login Analytics each need a one-time, non-SQL deploy step** (a Supabase Edge Function +
  secrets, see each section above) and haven't been exercised against their real external service yet
  — all were written from documentation/API reference, not a live test call.
- **Expenses & Projects deliberately omits OCR/AI Bill Entry and an AI Expense Assistant.** Both need
  a real, live LLM/vision API call — this app's first genuine departure from its "no live model call,
  only rule-based logic" precedent (AI Insights, the Interest Calculator's "AI comparison," etc. are
  all deterministic). That's a real architecture decision (which provider, where the key lives, cost)
  worth its own explicit go-ahead, not folded into an already-large batch. Also deferred: month-end
  closing/locking and a dedicated Construction Progress tracker (both real, distinct features the
  spec itself marks optional — the Custom Fields engine already lets you informally tag a "Phase" on
  a transaction today), and PDF export (Excel + CSV, via the already-loaded `xlsx` library, cover the
  actual "get my data out" need; PDF would mean a new client-side dependency worth its own decision).
- **Live Cross-Device Portfolio Sync's echo suppression is a 5-second time window, not exact per-row
  tracking.** Several of the 7 synced tables are mutated through RPCs (`fn_record_payment`,
  `fn_confirm_recurring_occurrence`, ...) as often as through a plain insert/update/delete, so a
  precise "was this exact row just written by me" check would need instrumenting every RPC call site
  individually. A coarse "I made some write in the last 5 seconds" flag covers every mutation path
  uniformly and is accurate for the common case (one person acting on one device at a time); the only
  real edge case it misses is two genuinely simultaneous edits from different devices landing within
  the same 5-second window, which would (rarely) suppress a toast that should have shown - the
  soft-refresh itself is never affected, only whether the toast appears.
- **Dashboard's own KPI/panel cards don't have the Customize Sidebar treatment.** `dashboard.js`
  builds its panels as one large inline template rather than a reorderable list of panel objects -
  retrofitting that safely is a bigger, separate change from the sidebar (see "Customize Sidebar"
  above for the full reasoning).

## Project structure

```
supabase/
  migrations/            28 SQL files, run once in order (see Setup)
  functions/
    gold-price-fetch/           fetches live gold prices (Gold Intelligence)
    send-notification-emails/   sends pending notification digests via Resend (Email Notifications)
    send-web-push/               sends real-time browser push via web-push (Web Push Notifications)
    admin-user-management/      create/deactivate/reactivate/delete accounts (Admin: User Management)
    benchmark-fetch/             fetches Nifty/Sensex history (Benchmark Comparison)
    log-login/                   logs sign-in events with consent (Visits & Login Analytics)
web/
  index.html             shell: nav, auth screen, shared modals, global search bar, PWA tags
  manifest.json           PWA manifest (installable "Add to Home Screen")
  sw.js                   same-origin-only service worker + Web Push handlers
  icons/                  app + maskable + Apple touch icons
  css/app.css
  js/lib/                supabaseClient.js (connection + auth), ui.js (modal + form helpers), utils.js,
                          globalSearch.js (topbar search), webrtc.js (calling), theme.js, demoData.js,
                          push.js (Web Push subscribe/unsubscribe), exportData.js (Excel export)
  js/data/api.js          the only file that calls supabase-js
  js/state.js             global filters (Section 38) + cached lookups
  js/calculations.js      client-side previews (what-if simulator, deal-form estimates)
  js/charts/              Chart.js wrappers
  js/router.js            hash-based view switching, no framework
  js/views/*.js           one module per nav section (now including blog.js, sharedWithMe.js)
  js/app.js               bootstraps auth + sidebar + router + global search + login analytics consent
```
