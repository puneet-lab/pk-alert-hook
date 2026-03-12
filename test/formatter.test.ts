import { describe, it, expect } from 'vitest';
import { formatGoogleChatCard } from '../src/formatter.js';
import { Severity, type AlertPayload } from '../src/types.js';

function makePayload(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    severity: Severity.ERROR,
    message: 'Something went wrong',
    stack: 'at foo (/src/bar.ts:10:5)',
    context: { userId: 'usr_123' },
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

function getCard(payload: AlertPayload) {
  const result = formatGoogleChatCard(payload);
  const cards = result.cardsV2 as Array<Record<string, unknown>>;
  return (cards[0] as Record<string, unknown>).card as Record<string, unknown>;
}

function getSections(payload: AlertPayload) {
  return getCard(payload).sections as Array<Record<string, unknown>>;
}

/** Extract context textParagraph texts — identified by `</b>:` pattern (bold key + colon) */
function getContextWidgets(sections: Array<Record<string, unknown>>): string[] {
  const results: string[] = [];
  for (const section of sections) {
    const widgets = section.widgets as Array<Record<string, unknown>>;
    for (const w of widgets) {
      const tp = w.textParagraph as Record<string, unknown> | undefined;
      if (tp && (tp.text as string).includes('</b>:')) {
        results.push(tp.text as string);
      }
    }
  }
  return results;
}

describe('formatGoogleChatCard', () => {
  it('produces a valid cardsV2 structure', () => {
    const result = formatGoogleChatCard(makePayload());
    expect(result).toHaveProperty('cardsV2');
    const cards = result.cardsV2 as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(1);

    const card = getCard(makePayload());
    expect(card).toHaveProperty('header');
    expect(card).toHaveProperty('sections');
  });

  // ─── Header ──────────────────────────────────────────────────

  it('header title contains appName', () => {
    const header = getCard(makePayload()).header as Record<string, unknown>;
    expect(header.title).toContain('test-app');
  });

  it('header subtitle contains ENV, severity level, and timestamp', () => {
    const header = getCard(makePayload()).header as Record<string, unknown>;
    const subtitle = header.subtitle as string;
    expect(subtitle).toContain('PRODUCTION');
    expect(subtitle).toContain('ERROR');
    expect(subtitle).toContain('14:30:00 UTC');
  });

  it('header subtitle shows WARNING for warning severity', () => {
    const header = getCard(makePayload({ severity: Severity.WARNING })).header as Record<string, unknown>;
    expect(header.subtitle).toContain('WARNING');
  });

  // ─── Error message section ────────────────────────────────────

  it('first section contains the error message in bold', () => {
    const sections = getSections(makePayload());
    const widgets = sections[0]!.widgets as Array<Record<string, unknown>>;
    const text = (widgets[0] as Record<string, unknown>).textParagraph as Record<string, unknown>;
    expect(text.text).toContain('<b>Something went wrong</b>');
  });

  // ─── Stack trace section ──────────────────────────────────────

  it('includes collapsible stack trace when stack is present', () => {
    const sections = getSections(makePayload());
    const stackSection = sections.find((s) => s.collapsible === true);
    expect(stackSection).toBeDefined();
    expect(stackSection!.uncollapsibleWidgetsCount).toBe(0);
  });

  it('omits stack trace section when no stack', () => {
    const sections = getSections(makePayload({ stack: undefined }));
    const stackSection = sections.find((s) => s.collapsible === true);
    expect(stackSection).toBeUndefined();
  });

  // ─── Context section ──────────────────────────────────────────

  it('renders each context entry as bold key + value on one line', () => {
    const sections = getSections(
      makePayload({ context: { orderId: 'ORD-1', route: '/api' } }),
    );
    const ctxWidgets = getContextWidgets(sections);
    expect(ctxWidgets).toHaveLength(2);
    expect(ctxWidgets[0]).toBe('<b>orderId</b>: ORD-1');
    expect(ctxWidgets[1]).toBe('<b>route</b>: /api');
  });

  it('merges globalContext with context', () => {
    const sections = getSections(
      makePayload({
        context: { orderId: 'ORD-1' },
        globalContext: { region: 'us-east-1' },
      }),
    );
    const ctxWidgets = getContextWidgets(sections);
    expect(ctxWidgets).toHaveLength(2);
    expect(ctxWidgets[0]).toBe('<b>region</b>: us-east-1');
    expect(ctxWidgets[1]).toBe('<b>orderId</b>: ORD-1');
  });

  // ─── Footer ───────────────────────────────────────────────────

  it('shows occurrence count when > 1', () => {
    const sections = getSections(makePayload({ occurrences: 5 }));
    const footer = sections[sections.length - 1]!;
    const widgets = footer.widgets as Array<Record<string, unknown>>;
    const text = (widgets[0] as Record<string, unknown>).textParagraph as Record<string, unknown>;
    expect(text.text).toContain('Occurred 5 times');
  });

  it('shows version in footer when provided', () => {
    const sections = getSections(makePayload({ version: '2.1.0' }));
    const footer = sections[sections.length - 1]!;
    const widgets = footer.widgets as Array<Record<string, unknown>>;
    const text = (widgets[0] as Record<string, unknown>).textParagraph as Record<string, unknown>;
    expect(text.text).toContain('v2.1.0');
  });

  it('no footer section when occurrences=1 and no version', () => {
    const sections = getSections(makePayload({ occurrences: 1, version: undefined }));
    const lastSection = sections[sections.length - 1]!;
    const widgets = lastSection.widgets as Array<Record<string, unknown>>;
    // Last section should be context (bold key lines), not a footer
    const lastText = (widgets[0] as Record<string, unknown>).textParagraph as Record<string, unknown>;
    expect(lastText.text).toContain('<b>');
    expect(lastText.text).not.toContain('Occurred');
  });

  // ─── No duplicate data ────────────────────────────────────────

  it('does not repeat appName or environment in body sections', () => {
    const sections = getSections(makePayload());
    // Skip header (tested separately) — check sections don't contain appName/env
    for (const section of sections) {
      expect(section.header).not.toBe('test-app');
      expect(section.header).not.toBe('production');
    }
  });

  // ─── XSS escaping ─────────────────────────────────────────────

  it('escapes HTML in error message', () => {
    const sections = getSections(makePayload({ message: '<script>alert("xss")</script>' }));
    const widgets = sections[0]!.widgets as Array<Record<string, unknown>>;
    const text = (widgets[0] as Record<string, unknown>).textParagraph as Record<string, unknown>;
    expect(text.text).not.toContain('<script>');
    expect(text.text).toContain('&lt;script&gt;');
  });

  it('escapes HTML in context keys', () => {
    const sections = getSections(
      makePayload({ context: { '<img src=x onerror=alert(1)>': 'value' } }),
    );
    const ctxWidgets = getContextWidgets(sections);
    expect(ctxWidgets[0]).not.toContain('<img');
    expect(ctxWidgets[0]).toContain('&lt;img');
  });

  it('escapes HTML in context values', () => {
    const sections = getSections(
      makePayload({ context: { key: '<script>steal()</script>' } }),
    );
    const ctxWidgets = getContextWidgets(sections);
    expect(ctxWidgets[0]).not.toContain('<script>steal');
    expect(ctxWidgets[0]).toContain('&lt;script&gt;');
  });

  it('escapes HTML in header appName', () => {
    const header = getCard(makePayload({ appName: '<b>evil</b>' })).header as Record<string, unknown>;
    expect(header.title).not.toContain('<b>evil');
    expect(header.title).toContain('&lt;b&gt;');
  });

  // ─── Preview text ───────────────────────────────────────────────

  it('includes text preview when showPreviewText is true', () => {
    const result = formatGoogleChatCard(makePayload({ showPreviewText: true }));
    expect(result.text).toBe('🔴 [PRODUCTION] test-app: Something went wrong');
  });

  it('omits text preview when showPreviewText is false', () => {
    const result = formatGoogleChatCard(makePayload({ showPreviewText: false }));
    expect(result.text).toBeUndefined();
  });
});
