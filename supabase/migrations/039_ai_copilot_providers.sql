-- ============================================================================
-- 039: AI Copilot Multi-Provider Support - lets the user pick which LLM
--      powers the AI Portfolio Copilot (038_ai_copilot_usage.sql), instead of
--      it being hardcoded to Anthropic Claude. The user has a Google AI
--      Studio (Gemini) key but no Anthropic key, so the Copilot needs to work
--      with whichever provider they actually have.
--
--      This is a direct mirror of Gold Intelligence's own proven
--      gold_providers/gold_settings design (019_gold_intelligence.sql) -
--      same shape, same admin-writable/everyone-readable RLS split, same
--      "custom provider" escape hatch with a secret-name-prefix safety
--      constraint (COPILOT_CUSTOM_ here, GOLD_CUSTOM_ there).
--
--      What does NOT change: copilot_usage / fn_copilot_check_and_record_
--      usage (038) - the per-user daily cap is already provider-agnostic and
--      is still checked before any provider is even loaded.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ai_providers - one row per known LLM provider, including any future custom
-- one. Global, not per-user: there is exactly one active provider for the
-- whole app instance (same reasoning as gold_providers - this is shared
-- infra configuration, not personal data).
-- ----------------------------------------------------------------------------
create table if not exists public.ai_providers (
  key text primary key,
  kind text not null check (kind in ('anthropic', 'google_gemini', 'custom')),
  display_name text not null,
  model_id text not null,
  -- Documented free-tier reference only, not enforced here - the real cost
  -- guard is copilot_usage's per-user daily cap (038), unchanged by this file.
  requests_limit int,
  last_used_at timestamptz,
  last_status text not null default 'never' check (last_status in ('never', 'ok', 'error')),
  last_error text,
  -- Only populated for kind='custom': { base_url, auth_secret_name }.
  -- Assumed OpenAI-compatible chat-completions shape (POST {base_url}/
  -- chat/completions, Authorization: Bearer <secret>, {model, messages}) -
  -- the shape virtually every other free/open model host implements (Groq,
  -- OpenRouter, Together, Fireworks, a local Ollama endpoint). auth_secret_name
  -- must start with COPILOT_CUSTOM_ - enforced below - so this table can
  -- never be pointed at an unrelated secret the Edge Function's environment
  -- happens to have.
  custom_config jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    kind <> 'custom'
    or custom_config is null
    or (custom_config->>'auth_secret_name') is null
    or (custom_config->>'auth_secret_name') like 'COPILOT_CUSTOM_%'
  )
);

alter table public.ai_providers enable row level security;

drop policy if exists "select ai_providers" on public.ai_providers;
create policy "select ai_providers"
  on public.ai_providers for select to authenticated using (true);

drop policy if exists "admin insert ai_providers" on public.ai_providers;
create policy "admin insert ai_providers"
  on public.ai_providers for insert to authenticated with check (private.is_admin());
drop policy if exists "admin update ai_providers" on public.ai_providers;
create policy "admin update ai_providers"
  on public.ai_providers for update to authenticated using (private.is_admin()) with check (private.is_admin());
drop policy if exists "admin delete ai_providers" on public.ai_providers;
create policy "admin delete ai_providers"
  on public.ai_providers for delete to authenticated using (private.is_admin());

drop trigger if exists set_ai_providers_updated_at on public.ai_providers;
create trigger set_ai_providers_updated_at
  before update on public.ai_providers
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on table public.ai_providers to authenticated;

insert into public.ai_providers (key, kind, display_name, model_id, requests_limit)
values
  ('anthropic', 'anthropic', 'Anthropic Claude', 'claude-sonnet-5', null),
  ('google_gemini', 'google_gemini', 'Google Gemini (AI Studio)', 'gemini-2.5-flash', 250)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- ai_settings - a true singleton (id is always 1). Defaults to Google Gemini
-- since the user has a Google AI Studio key today and no Anthropic key - the
-- feature should work out of the box once they set one secret, not need a
-- settings change first.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_settings (
  id int primary key default 1 check (id = 1),
  active_provider_key text references public.ai_providers(key),
  updated_at timestamptz not null default now()
);

alter table public.ai_settings enable row level security;

drop policy if exists "select ai_settings" on public.ai_settings;
create policy "select ai_settings"
  on public.ai_settings for select to authenticated using (true);
drop policy if exists "admin update ai_settings" on public.ai_settings;
create policy "admin update ai_settings"
  on public.ai_settings for update to authenticated using (private.is_admin()) with check (private.is_admin());

drop trigger if exists set_ai_settings_updated_at on public.ai_settings;
create trigger set_ai_settings_updated_at
  before update on public.ai_settings
  for each row execute function public.set_updated_at();

grant select, update on table public.ai_settings to authenticated;

insert into public.ai_settings (id, active_provider_key) values (1, 'google_gemini')
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- fn_ai_provider_record_use - called by the Edge Function (through the
-- CALLER's own client, not a service-role client - this function never
-- touches another user's data) after every attempt, successful or not.
-- ai_providers' own UPDATE policy is admin-only (choosing/configuring a
-- provider is an infra decision), so a regular user's client can't write
-- last_used_at/last_status directly - this SECURITY DEFINER function is the
-- one narrow door that lets ANY authenticated caller record a best-effort
-- status update, mirroring fn_gold_provider_record_fetch's exact role.
-- ----------------------------------------------------------------------------
create or replace function public.fn_ai_provider_record_use(
  p_key text, p_status text, p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_providers
  set last_used_at = now(), last_status = p_status, last_error = p_error
  where key = p_key;
end;
$$;

revoke execute on function public.fn_ai_provider_record_use(text, text, text) from public, anon;
grant execute on function public.fn_ai_provider_record_use(text, text, text) to authenticated;
