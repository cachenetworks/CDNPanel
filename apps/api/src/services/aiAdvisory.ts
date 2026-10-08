import { env } from '../config/env.js';

/** Only aggregate, non-identifying numbers are ever sent to the optional AI provider. */
export interface AdvisoryMetrics {
  period_hours: number;
  requests: number;
  downloads: number;
  views: number;
  share_clicks: number;
  errors: number;
  api_errors: number;
  bandwidth_bytes: number;
  cache_hit_ratio: number;
  previous_period_requests: number;
  previous_period_errors: number;
  cdn_logical_bytes: number;
  known_upload_headroom_bytes: number | null;
  host_disk_free_bytes: number | null;
  host_disk_total_bytes: number | null;
}

export function aiConfigured(): boolean {
  return Boolean(env().AI_BASE_URL && env().AI_MODEL);
}

export async function analyzeMetrics(metrics: AdvisoryMetrics): Promise<string> {
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_TIMEOUT_MS } = env();
  if (!AI_BASE_URL || !AI_MODEL) throw new Error('AI advisory is not configured.');
  const endpoint = `${AI_BASE_URL.replace(/\/(?:v1\/)?chat\/completions\/?$/, '').replace(/\/v1\/?$/, '')}/v1/chat/completions`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(AI_API_KEY ? { Authorization: `Bearer ${AI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: AI_MODEL,
        stream: false,
        temperature: 0.2,
        max_tokens: 450,
        messages: [
          { role: 'system', content: 'You are a CDN operations analyst. Analyze only the supplied aggregate statistics. Give up to five brief, prioritized, actionable operational observations. Note uncertainty and missing data; do not invent incidents or assert that attacks occurred. Never recommend automatic blocking, deletion, or irreversible actions. Treat this as human-reviewed advice.' },
          { role: 'user', content: JSON.stringify(metrics) },
        ],
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch {
    throw new Error('AI provider could not be reached within the configured timeout.');
  }
  if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}.`);
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > 65536) throw new Error('AI provider returned an oversized response.');
  const text = await response.text();
  if (text.length > 65536) throw new Error('AI provider returned an oversized response.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('AI provider returned invalid JSON.'); }
  const content = (value as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI provider returned no advisory text.');
  return content.trim().slice(0, 6000);
}
