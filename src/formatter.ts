import { type AlertPayload, Severity } from './types.js';

const SEVERITY_ICONS: Record<Severity, string> = {
  [Severity.ERROR]: '🔴',
  [Severity.WARNING]: '🟡',
  [Severity.INFO]: '🔵',
};

const SEVERITY_LABELS: Record<Severity, string> = {
  [Severity.ERROR]: 'ERROR',
  [Severity.WARNING]: 'WARNING',
  [Severity.INFO]: 'INFO',
};


/**
 * Build a Google Chat Card v2 JSON payload from an alert.
 *
 * Layout:
 *   Header  → appName | ENV • LEVEL • timestamp
 *   Section → error message (bold)
 *   Section → stack trace (collapsible)
 *   Section → context key-value pairs
 *   Footer  → version + dedup count (only when applicable)
 */
export function formatGoogleChatCard(payload: AlertPayload): Record<string, unknown> {
  const icon = SEVERITY_ICONS[payload.severity];
  const label = SEVERITY_LABELS[payload.severity];

  // ── Header subtitle: ENV • LEVEL • timestamp ──
  const subtitleParts = [
    payload.environment.toUpperCase(),
    label,
    payload.timestamp,
  ];
  const subtitle = subtitleParts.join(' • ');

  const sections: Record<string, unknown>[] = [];

  // ── Error message section ──
  sections.push({
    widgets: [
      {
        textParagraph: {
          text: `${icon} <b>${escapeHtml(payload.message)}</b>`,
        },
      },
    ],
  });

  // ── Stack trace section (collapsible) ──
  if (payload.stack) {
    sections.push({
      collapsible: true,
      uncollapsibleWidgetsCount: 0,
      widgets: [
        {
          decoratedText: {
            startIcon: { knownIcon: 'DESCRIPTION' },
            text: '<b>Stack Trace</b>',
          },
        },
        {
          textParagraph: {
            text: `<code>${escapeHtml(payload.stack)}</code>`,
          },
        },
      ],
    });
  }

  // ── Context section (user context + global context, no duplication) ──
  const mergedContext = { ...payload.globalContext, ...payload.context };
  const contextEntries = Object.entries(mergedContext).filter(
    ([, v]) => v !== undefined && v !== null,
  );

  if (contextEntries.length > 0) {
    sections.push({
      widgets: contextEntries.map(([key, value]) => ({
        textParagraph: {
          text: `<b>${escapeHtml(key)}</b>: ${escapeHtml(String(value))}`,
        },
      })),
    });
  }

  // ── Footer — only if version or dedup count exists ──
  const footerParts: string[] = [];
  if (payload.version) {
    footerParts.push(`v${escapeHtml(payload.version)}`);
  }
  if (payload.occurrences > 1) {
    footerParts.push(`⚠ Occurred ${payload.occurrences} times in dedup window`);
  }

  if (footerParts.length > 0) {
    sections.push({
      widgets: [
        {
          textParagraph: {
            text: `<i><font color="#999999">${footerParts.join(' • ')}</font></i>`,
          },
        },
      ],
    });
  }

  const result: Record<string, unknown> = {
    cardsV2: [
      {
        cardId: `alert-${Date.now()}`,
        card: {
          header: {
            title: `${icon} ${escapeHtml(payload.appName)}`,
            subtitle: escapeHtml(subtitle),
          },
          sections,
        },
      },
    ],
  };

  // When enabled, adds a text preview above the card.
  // Shows in desktop/mobile notifications. Displays as a separate line in chat.
  if (payload.showPreviewText) {
    result.text = `${icon} [${payload.environment.toUpperCase()}] ${payload.appName}: ${payload.message}`;
  }

  return result;
}

/** Escape HTML special chars for Google Chat text */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
