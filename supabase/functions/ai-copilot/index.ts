// ai-copilot - this app's first live LLM API call. Answers a question about
// the caller's OWN portfolio, grounded only in real numbers the client
// already computed/fetched (Net Worth, Cash Flow, and the same summary/
// aggregate views this app's other pages already trust) - the same "never
// invent a figure, everything traceable to real records" precedent
// fn_generate_ai_insights() (009_functions.sql) already established, just
// with the phrasing step handed to an LLM instead of a fixed SQL template.
//
// Auth pattern: identical to log-login's "Pattern 1" shape - an anon-key
// client seeded with the caller's own Authorization header, identify them via
// .auth.getUser(), and do everything else (the usage-cap RPC, the provider
// lookup) through that SAME caller-scoped client so RLS naturally limits
// what it can touch. No service-role client anywhere in this function - it
// never needs to see another user's data or write anything privileged.
//
// Provider selection (039_ai_copilot_providers.sql) - mirrors gold-price-
// fetch's own kind-branching design exactly: ai_settings.active_provider_key
// picks one row from ai_providers, and this function branches on that row's
// `kind`. The usage-cap check-and-reject sequence runs BEFORE any provider
// is even loaded, so an over-cap question never reaches a provider lookup,
// let alone an API call.
//
// Deploy: supabase functions deploy ai-copilot
//   Only the secret for whichever provider is actually ACTIVE needs to be set:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...      (if kind=anthropic active)
//   supabase secrets set GOOGLE_AI_API_KEY=...              (if kind=google_gemini active)
//   supabase secrets set COPILOT_CUSTOM_<yourname>=...      (if kind=custom active)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Hard per-user daily cap - confirmed by the user before building this
// feature, so a bug or a curious user hammering the button can't run up
// unexpected API cost. Enforced atomically in Postgres
// (fn_copilot_check_and_record_usage, 038_ai_copilot_usage.sql) BEFORE this
// function ever calls any provider - a rejected request costs nothing.
// Provider-agnostic, unchanged by the multi-provider rework.
const DAILY_LIMIT = 20;

const SYSTEM_PROMPT = `You are the AI Portfolio Copilot inside a personal investment tracking app.
Answer the user's question using ONLY the portfolio data JSON provided below - never invent a number,
balance, deal name, or figure that isn't actually present in that data. If the data needed to answer
isn't included, say so plainly instead of guessing. Cite specific numbers from the data when you use
them. Keep answers concise and conversational - this is a chat interface, not a report.`;

async function callAnthropic(provider: { model_id: string }, question: string, context: unknown): Promise<string> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY secret is not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: provider.model_id,
      // Deliberately short - this is a conversational chat answer over a
      // small JSON context, not a long-form generation task.
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Portfolio data (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n').trim();
}

// Google Gemini (AI Studio) - confirmed via Google's own API documentation
// (ai.google.dev/api/generate-content), not guessed: the API key is a QUERY
// PARAMETER, not a header, and the system prompt is a separate top-level
// field from the user's content.
async function callGemini(provider: { model_id: string }, question: string, context: unknown): Promise<string> {
  const apiKey = Deno.env.get('GOOGLE_AI_API_KEY');
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY secret is not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model_id)}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: { text: SYSTEM_PROMPT } },
      contents: [{ parts: [{ text: `Portfolio data (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question}` }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Gemini response missing candidates[0].content.parts[0].text: ' + JSON.stringify(data).slice(0, 300));
  return text.trim();
}

// Custom provider - exactly one supported shape (OpenAI-compatible chat
// completions), the same "one shape covers virtually everything else"
// scope decision gold-price-fetch's own custom slot made. Covers Groq,
// OpenRouter, Together, Fireworks, a local Ollama endpoint, etc.
async function callCustomProvider(provider: { model_id: string; custom_config: Record<string, any> | null }, question: string, context: unknown): Promise<string> {
  const config = provider.custom_config || {};
  const { base_url, auth_secret_name } = config;
  if (!base_url) throw new Error('Custom provider is missing base_url');
  if (!auth_secret_name || !String(auth_secret_name).startsWith('COPILOT_CUSTOM_')) {
    throw new Error('Refusing to read a secret not prefixed COPILOT_CUSTOM_');
  }
  const secretValue = Deno.env.get(auth_secret_name);
  if (!secretValue) throw new Error(`Secret ${auth_secret_name} is not set`);

  const res = await fetch(`${base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretValue}` },
    body: JSON.stringify({
      model: provider.model_id,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Portfolio data (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Custom provider error (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('Custom provider response missing choices[0].message.content: ' + JSON.stringify(data).slice(0, 300));
  return text.trim();
}

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: 'Not authenticated.' }, 401);

    const body = await req.json().catch(() => ({}));
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    const context = body?.context && typeof body.context === 'object' ? body.context : {};
    if (!question) return json({ ok: false, error: 'A question is required.' }, 400);

    // Atomic check-and-increment, through the CALLER's own client so RLS
    // scopes it to their own usage row - reject before ever loading a
    // provider if they're already over today's limit.
    const { data: usageRows, error: usageErr } = await callerClient.rpc('fn_copilot_check_and_record_usage', { p_daily_limit: DAILY_LIMIT });
    if (usageErr) {
      console.error('ai-copilot: usage check failed for user', userData.user.id, usageErr.message);
      return json({ ok: false, error: usageErr.message }, 500);
    }
    const usage = Array.isArray(usageRows) ? usageRows[0] : usageRows;
    if (!usage?.allowed) {
      return json({ ok: false, error: `Daily question limit reached (${DAILY_LIMIT}/day) - resets tomorrow.`, requestsUsed: usage?.requests_used ?? DAILY_LIMIT + 1, dailyLimit: DAILY_LIMIT });
    }

    const { data: settings, error: settingsErr } = await callerClient.from('ai_settings').select('*').eq('id', 1).single();
    if (settingsErr || !settings?.active_provider_key) return json({ ok: false, error: 'No active AI provider configured.' }, 500);

    const { data: provider, error: providerErr } = await callerClient.from('ai_providers').select('*').eq('key', settings.active_provider_key).single();
    if (providerErr || !provider) return json({ ok: false, error: 'Active AI provider not found: ' + settings.active_provider_key }, 500);

    let answer: string;
    try {
      if (provider.kind === 'anthropic') answer = await callAnthropic(provider, question, context);
      else if (provider.kind === 'google_gemini') answer = await callGemini(provider, question, context);
      else if (provider.kind === 'custom') answer = await callCustomProvider(provider, question, context);
      else throw new Error('Unknown provider kind: ' + provider.kind);
    } catch (callErr) {
      const message = callErr instanceof Error ? callErr.message : String(callErr);
      console.error('ai-copilot: provider call failed for user', userData.user.id, 'provider', provider.key, message);
      // Best-effort status update via the SECURITY DEFINER function - direct
      // table access is admin-only (ai_providers' own RLS), and this is
      // informational display only, not a cost/security boundary like the
      // usage cap above, so a failure here is swallowed, not surfaced.
      await callerClient.rpc('fn_ai_provider_record_use', { p_key: provider.key, p_status: 'error', p_error: message }).then(() => {}, () => {});
      return json({ ok: false, error: 'The AI Copilot is temporarily unavailable. Please try again shortly.' }, 502);
    }

    await callerClient.rpc('fn_ai_provider_record_use', { p_key: provider.key, p_status: 'ok', p_error: null }).then(() => {}, () => {});

    console.log('ai-copilot: answered question for user', userData.user.id, 'via', provider.key, '- requests used today:', usage.requests_used);
    return json({ ok: true, answer, providerDisplayName: provider.display_name, requestsUsed: usage.requests_used, dailyLimit: DAILY_LIMIT });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('ai-copilot: unhandled error:', message);
    return json({ ok: false, error: message }, 500);
  }
});
