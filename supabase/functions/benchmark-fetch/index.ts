// benchmark-fetch - powers the Analytics page's Benchmark Comparison panel
// (realized ROI vs Nifty 50 / Sensex over the same period). Mirrors
// gold-price-fetch's own structure closely: a scheduled Edge Function that
// fetches an external price series and upserts it into a shared table.
//
// Data source: the unofficial Yahoo Finance chart endpoint
// (query1.finance.yahoo.com/v8/finance/chart/<symbol>) - confirmed live via
// WebFetch while planning this (returns real daily OHLC history, no API
// key/auth header needed). This is the same endpoint every free
// "yfinance-style" Nifty/Sensex script relies on; it is UNOFFICIAL, not a
// documented/guaranteed-stable API - if Yahoo ever changes or blocks it,
// this function's error will show the actual response shape received,
// same "no live test was possible this session" honesty as gold-price-fetch's
// own header comment.
//
// No API key needed at all - deploy with:
//   supabase functions deploy benchmark-fetch
//
// Scheduled the same way as gold-price-fetch: a Supabase Dashboard Cron Job
// (Database -> Cron Jobs), once a day is plenty (index closes don't change
// intraday in a way this app needs to react to).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const YAHOO_SYMBOLS: Record<string, string> = { NIFTY50: '%5ENSEI', SENSEX: '%5EBSESN' };

async function fetchYahooHistory(yahooSymbol: string): Promise<{ date: string; close: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`); }
  const result = data?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp;
  const closes: number[] = result?.indicators?.quote?.[0]?.close;
  if (!timestamps || !closes) throw new Error('Unexpected Yahoo Finance response shape: ' + JSON.stringify(data).slice(0, 300));
  const out: { date: string; close: number }[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null) continue; // a non-trading day comes back as null, not omitted
    out.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: Math.round(close * 100) / 100 });
  }
  return out;
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const results: Record<string, { ok: boolean; rows?: number; error?: string }> = {};

  for (const [symbol, yahooSymbol] of Object.entries(YAHOO_SYMBOLS)) {
    try {
      const history = await fetchYahooHistory(yahooSymbol);
      const rows = history.map((h) => ({ symbol, observed_date: h.date, close_value: h.close }));
      const { error } = await supabase.from('benchmark_observations').upsert(rows, { onConflict: 'symbol,observed_date' });
      if (error) { results[symbol] = { ok: false, error: error.message }; continue; }
      results[symbol] = { ok: true, rows: rows.length };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results[symbol] = { ok: false, error: message };
    }
  }

  const anyOk = Object.values(results).some((r) => r.ok);
  return json({ ok: anyOk, results });
});
