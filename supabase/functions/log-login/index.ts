// log-login - called once per sign-in from the client, AFTER the user has
// already answered the one-time consent prompt (app.js's enterApp() path).
//
// Scope decision (stated plainly, see the plan's Context section): the
// original request included "if consent is rejected, take available
// information anyway." That is NOT what this does - a decline still logs a
// bare row (timestamp + user, so "logins today" stays accurate for admin),
// but IP/geo/device fields are only ever populated when consent=true was
// actually sent. There is no server-side fallback path that collects them
// on a decline; if that's genuinely wanted, it's a deliberate reversal of
// this file, not a bug to report.
//
// IP comes from Deno's own request headers on Supabase's edge network
// (x-forwarded-for), never from anything the client claims. Geo lookup via
// ipapi.co (keyless free tier, HTTPS) is best-effort and swallowed on
// failure - a failed geo lookup never blocks the login event from being
// recorded, same "never let an enrichment step break the core write"
// pattern as every other Edge Function in this project.
//
// Deploy: supabase functions deploy log-login (no extra secrets needed).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function parseUserAgent(ua: string): { browser: string; os: string; deviceType: string } {
  const browser =
    /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari' : 'Other';
  const os =
    /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' :
    /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const deviceType = /Mobile|Android|iPhone/.test(ua) ? 'Mobile' : /iPad|Tablet/.test(ua) ? 'Tablet' : 'Desktop';
  return { browser, os, deviceType };
}

async function geoLookup(ip: string): Promise<{ city: string | null; region: string | null; country: string | null }> {
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
    if (!res.ok) return { city: null, region: null, country: null };
    const data = await res.json();
    if (data.error) return { city: null, region: null, country: null };
    return { city: data.city || null, region: data.region || null, country: data.country_name || null };
  } catch {
    return { city: null, region: null, country: null };
  }
}

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: 'Not authenticated.' }, 401);

    const body = await req.json().catch(() => ({}));
    const consent = body?.consent === true;
    const clientUserAgent = typeof body?.userAgent === 'string' ? body.userAgent : '';

    const row: Record<string, unknown> = {
      user_id: userData.user.id,
      consent_given: consent,
    };

    if (consent) {
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
      row.ip_address = ip;
      row.user_agent = clientUserAgent || null;
      if (clientUserAgent) {
        const { browser, os, deviceType } = parseUserAgent(clientUserAgent);
        row.browser = browser;
        row.os = os;
        row.device_type = deviceType;
      }
      if (ip) {
        const geo = await geoLookup(ip);
        row.city = geo.city;
        row.region = geo.region;
        row.country = geo.country;
      }
    }

    const serviceDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error: insertErr } = await serviceDb.from('login_events').insert(row);
    if (insertErr) {
      // Deno.serve only auto-logs uncaught exceptions, not a JSON error
      // response like this one - without an explicit console.error, this
      // failure is invisible in the Function Logs panel (you'd only ever
      // see the generic boot/shutdown lines around it, no matter what went
      // wrong). Log it so a real failure here is actually diagnosable.
      console.error('log-login: insert failed for user', userData.user.id, insertErr.message);
      return json({ ok: false, error: insertErr.message }, 500);
    }

    console.log('log-login: recorded sign-in for user', userData.user.id, 'consent=', consent);
    return json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('log-login: unhandled error:', message);
    return json({ ok: false, error: message }, 500);
  }
});
