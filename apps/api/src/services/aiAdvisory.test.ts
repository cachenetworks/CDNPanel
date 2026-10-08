import { afterEach, describe, expect, it, vi } from 'vitest';

const config = {
  AI_BASE_URL: 'http://localhost:3847/v1',
  AI_MODEL: 'test-model',
  AI_API_KEY: 'test-token',
  AI_TIMEOUT_MS: 1500,
};
vi.mock('../config/env.js', () => ({ env: () => config }));

import { analyzeMetrics, type AdvisoryMetrics } from './aiAdvisory.js';

const metrics: AdvisoryMetrics = {
  period_hours: 24,
  requests: 42,
  downloads: 8,
  views: 12,
  share_clicks: 3,
  errors: 2,
  api_errors: 1,
  bandwidth_bytes: 200000,
  cache_hit_ratio: 0.3,
  previous_period_requests: 20,
  previous_period_errors: 0,
  cdn_logical_bytes: 700000,
  known_upload_headroom_bytes: 300000,
  host_disk_free_bytes: 500000,
  host_disk_total_bytes: 1000000,
};

afterEach(() => vi.unstubAllGlobals());

describe('AI advisory', () => {
  it.each(['http://localhost:3847', 'http://localhost:3847/v1', 'http://localhost:3847/v1/chat/completions'])(
    'uses a single OpenAI-compatible completion endpoint for %s', async (base) => {
      config.AI_BASE_URL = base;
      const fetcher = vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), text: async () => JSON.stringify({ choices: [{ message: { content: 'Consider checking error spikes.' } }] }) });
      vi.stubGlobal('fetch', fetcher);
      expect(await analyzeMetrics(metrics)).toBe('Consider checking error spikes.');
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3847/v1/chat/completions');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
      const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] };
      expect(JSON.parse(body.messages[1]!.content)).toEqual(metrics);
    },
  );

  it('returns a safe provider error without leaking response content', async () => {
    config.AI_BASE_URL = 'http://localhost:3847/v1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    await expect(analyzeMetrics(metrics)).rejects.toThrow('AI provider returned HTTP 502.');
  });
});
