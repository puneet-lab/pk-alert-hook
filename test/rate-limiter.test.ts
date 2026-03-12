import { describe, it, expect, afterEach, vi } from 'vitest';
import { RateLimiter } from '../src/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it('allows first occurrence of a fingerprint', () => {
    limiter = new RateLimiter(60_000);
    const result = limiter.check('err-1');
    expect(result).toEqual({ shouldSend: true, count: 1 });
  });

  it('suppresses duplicate within the window', () => {
    limiter = new RateLimiter(60_000);

    limiter.check('err-1'); // first
    const second = limiter.check('err-1');

    expect(second).toEqual({ shouldSend: false, count: 2 });
  });

  it('allows different fingerprints independently', () => {
    limiter = new RateLimiter(60_000);

    const r1 = limiter.check('err-1');
    const r2 = limiter.check('err-2');

    expect(r1.shouldSend).toBe(true);
    expect(r2.shouldSend).toBe(true);
  });

  it('sends with accumulated count after window expires', () => {
    limiter = new RateLimiter(100); // 100ms window

    limiter.check('err-1');
    limiter.check('err-1');
    limiter.check('err-1');

    // Simulate time passing
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);

    const result = limiter.check('err-1');
    expect(result).toEqual({ shouldSend: true, count: 4 });

    vi.useRealTimers();
  });

  it('flush returns pending counts and clears state', () => {
    limiter = new RateLimiter(60_000);

    limiter.check('err-1');
    limiter.check('err-1');
    limiter.check('err-1');
    limiter.check('err-2');

    const pending = limiter.flush();

    expect(pending.get('err-1')).toBe(3);
    expect(pending.has('err-2')).toBe(false); // count 1, not pending
    expect(limiter.size).toBe(0);
  });

  it('destroy clears everything', () => {
    limiter = new RateLimiter(60_000);
    limiter.check('err-1');
    limiter.destroy();
    expect(limiter.size).toBe(0);
  });
});
