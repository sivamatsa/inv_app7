// gold-price-fetch (Gold Intelligence addendum) - the one piece of this
// project that needs a real outbound HTTPS call to a third-party service
// with a secret API key, which is exactly what pure Postgres/RLS cannot do
// safely. Deployed and given its secrets by the user via the Supabase CLI:
//
//   supabase functions deploy gold-price-fetch
//   supabase secrets set METALPRICEAPI_KEY=... GOLDAPI_KEY=...
//   (goldprice.dev needs no key at all)
//
// Called two ways:
//   1. Manually, via App.api.refreshGoldPrice() -> client().functions.
//      invoke('gold-price-fetch') from the signed-in user's own session.
//   2. Automatically, once a day, via a Supabase Dashboard "Cron Job"
//      (Database -> Cron Jobs) pointed at this function's URL - NOT via
//      pg_cron/pg_net, since this project has never used either and
//      storing a service-role key inside SQL just to avoid one dashboard
//      click is a worse trade (see 019_gold_intelligence.sql's header
//      comment and the README's Gold Intelligence section).
//
// IMPORTANT, stated plainly rather than glossed over: the exact response
// shape assumed below for each provider was determined from that
// provider's own public documentation/announcements, not from a live test
// call (no live Supabase project or provider API key was available while
// writing this). Self-reviewed for correctness, but genuinely unverified -
// the first real call against each provider is the actual test. If a
// provider's real response doesn't match what's parsed here, the error
// message returned (and stored in gold_providers.last_error) will show the
// raw response shape received, which is the fastest way to fix the mapping.
//
// Uses the service-role key internally (bypasses RLS entirely, by design -
// gold_price_observations has no INSERT policy for regular users at all,
// only this function is meant to ever write to it).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GRAMS_PER_TROY_OZ = 31.1034768;

type PurityPrices = { '24K': number; '22K': number; '18K': number };

function purityFrom24k(price24k: number): PurityPrices {
  return { '24K': price24k, '22K': price24k * (22 / 24), '18K': price24k * (18 / 24) };
}

// Simple, safe dot-path walker for custom providers - "a.b[0].c" style only,
// no eval/vm, so an admin-supplied path string can never execute code, only
// read a value out of the parsed JSON response.
function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.').flatMap((segment) => {
    const base = segment.replace(/\[\d+\]/g, '');
    const indices = [...segment.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    return base ? [base, ...indices] : indices;
  });
  let cur: any = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part as any];
  }
  return cur;
}

async function fetchJson(url: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// MetalpriceAPI: returns the raw XAU spot rate only - we do the 24K/22K/18K
// purity math ourselves. `rates.INR` when base=XAU is "how many INR for one
// troy ounce of gold" (the standard convention for a metal-as-base rate).
async function fetchMetalPriceApi(): Promise<PurityPrices> {
  const key = Deno.env.get('METALPRICEAPI_KEY');
  if (!key) throw new Error('METALPRICEAPI_KEY secret is not set');
  const data = await fetchJson(`https://api.metalpriceapi.com/v1/latest?api_key=${key}&base=XAU&currencies=INR`);
  if (!data.success) throw new Error('MetalpriceAPI returned success=false: ' + JSON.stringify(data).slice(0, 300));
  const perTroyOz = parseFloat(data.rates?.INR);
  if (!perTroyOz) throw new Error('MetalpriceAPI response missing/non-numeric rates.INR: ' + JSON.stringify(data).slice(0, 300));
  return purityFrom24k(perTroyOz / GRAMS_PER_TROY_OZ);
}

// GoldAPI.io: already returns per-karat gram prices directly - no purity
// math needed on our side. parseFloat guards against a provider that
// returns these as strings, same as goldprice.dev turned out to (its docs
// show "price_gram_24k": "153.42") - parseFloat is a safe no-op if the
// value is already a genuine number.
async function fetchGoldApiIo(): Promise<PurityPrices> {
  const key = Deno.env.get('GOLDAPI_KEY');
  if (!key) throw new Error('GOLDAPI_KEY secret is not set');
  const data = await fetchJson('https://www.goldapi.io/api/XAU/INR', {
    headers: { 'x-access-token': key, 'Content-Type': 'application/json' },
  });
  const p24 = parseFloat(data.price_gram_24k), p22 = parseFloat(data.price_gram_22k), p18 = parseFloat(data.price_gram_18k);
  if (!p24 || !p22 || !p18) throw new Error('GoldAPI.io response missing/non-numeric price_gram_24k/22k/18k: ' + JSON.stringify(data).slice(0, 300));
  return { '24K': p24, '22K': p22, '18K': p18 };
}

// goldprice.dev /v1/carat: confirmed live (via its own published docs) to
// live on the api. subdomain, not the marketing site itself - the first
// deployed version of this function pointed at https://goldprice.dev/...
// and got that site's own Next.js 404 page back instead of JSON. Response
// fields are price_gram_24k/22k/18k (same naming as GoldAPI.io) but as
// STRINGS ("153.42"), not numbers - parseFloat before use.
async function fetchGoldPriceDev(): Promise<PurityPrices> {
  const data = await fetchJson('https://api.goldprice.dev/v1/carat?currency=INR');
  const p24 = parseFloat(data.price_gram_24k), p22 = parseFloat(data.price_gram_22k), p18 = parseFloat(data.price_gram_18k);
  if (!p24 || !p22 || !p18) throw new Error('goldprice.dev response missing price_gram_24k/22k/18k fields: ' + JSON.stringify(data).slice(0, 300));
  return { '24K': p24, '22K': p22, '18K': p18 };
}

// Custom provider: exactly one supported shape (spot price + our own
// purity math) per the plan's scope decision - GoldAPI.io/goldprice.dev's
// "pre-computed purity fields" shape is the unusual one, not worth exposing
// generically in the Add Custom Provider form.
async function fetchCustomSpotProvider(config: Record<string, any>): Promise<PurityPrices> {
  const { base_url, auth_style, auth_key_name, auth_secret_name, spot_path, spot_unit } = config;
  let url = base_url as string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth_secret_name) {
    if (!auth_secret_name.startsWith('GOLD_CUSTOM_')) throw new Error('Refusing to read a secret not prefixed GOLD_CUSTOM_');
    const secretValue = Deno.env.get(auth_secret_name);
    if (!secretValue) throw new Error(`Secret ${auth_secret_name} is not set`);
    if (auth_style === 'header') headers[auth_key_name || 'x-api-key'] = secretValue;
    else if (auth_style === 'bearer') headers['Authorization'] = `Bearer ${secretValue}`;
    else if (auth_style === 'query_param') url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(auth_key_name || 'apikey')}=${encodeURIComponent(secretValue)}`;
  }
  const data = await fetchJson(url, { headers });
  const rawSpotValue = getPath(data, spot_path);
  const spotValue = typeof rawSpotValue === 'string' ? parseFloat(rawSpotValue) : rawSpotValue;
  if (typeof spotValue !== 'number' || !Number.isFinite(spotValue)) throw new Error(`Custom provider: no numeric value at path "${spot_path}" in response: ${JSON.stringify(data).slice(0, 300)}`);
  const perGram24k = spot_unit === 'troy_oz' ? spotValue / GRAMS_PER_TROY_OZ : spotValue;
  return purityFrom24k(perGram24k);
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  try {
    const { data: settings, error: settingsErr } = await supabase.from('gold_settings').select('*').eq('id', 1).single();
    if (settingsErr || !settings?.active_provider_key) return json({ ok: false, error: 'No active gold provider configured.' });

    const { data: provider, error: providerErr } = await supabase.from('gold_providers').select('*').eq('key', settings.active_provider_key).single();
    if (providerErr || !provider) return json({ ok: false, error: 'Active provider not found: ' + settings.active_provider_key });

    let prices: PurityPrices;
    try {
      if (provider.kind === 'metalpriceapi') prices = await fetchMetalPriceApi();
      else if (provider.kind === 'goldapi_io') prices = await fetchGoldApiIo();
      else if (provider.kind === 'goldprice_dev') prices = await fetchGoldPriceDev();
      else if (provider.kind === 'custom') prices = await fetchCustomSpotProvider(provider.custom_config || {});
      else throw new Error('Unknown provider kind: ' + provider.kind);
    } catch (fetchErr) {
      // Section 4's explicit rule: retain the last known value, never
      // fabricate one - so no observation row is written on failure, only
      // the provider's own status/error is recorded.
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      await supabase.rpc('fn_gold_provider_record_fetch', { p_key: provider.key, p_status: 'error', p_error: message });
      return json({ ok: false, error: message });
    }

    const observedAt = new Date().toISOString();
    const rows = (['24K', '22K', '18K'] as const).map((purity) => ({
      provider_key: provider.key, price_type: 'SPOT', purity, currency: 'INR', unit: 'gram',
      price: Math.round(prices[purity] * 100) / 100, observed_at: observedAt,
    }));
    const { error: insertErr } = await supabase.from('gold_price_observations').insert(rows);
    if (insertErr) {
      await supabase.rpc('fn_gold_provider_record_fetch', { p_key: provider.key, p_status: 'error', p_error: insertErr.message });
      return json({ ok: false, error: insertErr.message });
    }

    await supabase.rpc('fn_gold_provider_record_fetch', { p_key: provider.key, p_status: 'ok', p_error: null });
    return json({ ok: true, provider: provider.key, observed_at: observedAt, prices });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: message }, 500);
  }
});
