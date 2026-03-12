import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleChatProvider } from '../src/providers/google-chat.js';
import { Severity, type AlertPayload } from '../src/types.js';

function makePayload(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    severity: Severity.ERROR,
    message: 'Test error',
    stack: 'at test (/test.ts:1:1)',
    context: {},
    globalContext: {},
    appName: 'test-app',
    environment: 'production',
    timestamp: '12/03/2026, 14:30:00 UTC',
    fingerprint: 'test-fp',
    occurrences: 1,
    showPreviewText: true,
    ...overrides,
  };
}

describe('GoogleChatProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends POST request to webhook URL with JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const provider = new GoogleChatProvider('https://chat.googleapis.com/v1/spaces/test/messages?key=abc');
    await provider.send(makePayload());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chat.googleapis.com/v1/spaces/test/messages?key=abc');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json; charset=UTF-8' });

    const body = JSON.parse(options.body as string);
    expect(body).toHaveProperty('cardsV2');
  });

  it('throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve('Invalid webhook'),
    });

    const provider = new GoogleChatProvider('https://chat.googleapis.com/v1/spaces/test');

    await expect(provider.send(makePayload())).rejects.toThrow(
      'Google Chat webhook failed: 403 Forbidden',
    );
  });

  it('handles text() failure gracefully on error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.reject(new Error('stream error')),
    });

    const provider = new GoogleChatProvider('https://chat.googleapis.com/v1/spaces/test');

    await expect(provider.send(makePayload())).rejects.toThrow(
      'Google Chat webhook failed: 500 Internal Server Error — unknown',
    );
  });
});
