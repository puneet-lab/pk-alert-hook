# pk-alert-hook

Lightweight runtime error alerting via **Google Chat** webhooks — instant notifications when your services break. No dashboard, no paid alert providers, just alerts where your team already works.

> **Google Chat only.** More providers (Slack, Discord) may come later. For now, this library supports Google Chat webhooks exclusively.

## Install

```bash
npm install pk-alert-hook
```

Requires Node.js 18+ (uses native `fetch`).

## Google Chat Webhook Setup

1. Open [Google Chat](https://chat.google.com) → open or create a **Space**
2. Click the **space name** at the top → **Apps & integrations** → **Manage webhooks**
3. Click **Add another**, name it `pk-alert-hook`, click **Save**
4. **Copy the webhook URL** (looks like `https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...`)
5. Add to your `.env`:

```env
PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/YOUR_SPACE/messages?key=YOUR_KEY&token=YOUR_TOKEN
```

> **Security:** This URL contains auth tokens. Never commit it to git. Make sure `.env` is in your `.gitignore`.

If you don't see "Manage webhooks", your Workspace admin needs to enable it:
**Admin Console → Apps → Google Workspace → Google Chat → Manage webhooks: ON**

## Quick Start

```ts
import { AlertHook } from 'pk-alert-hook';

// Initialize once at app startup
AlertHook.init({
  webhookUrl: process.env.PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL,
  environment: process.env.NODE_ENV,
  allowedEnvs: ['production', 'staging'],
  appName: 'my-api',
});

// Use in any catch block
try {
  await processOrder(orderId);
} catch (err) {
  AlertHook.capture(err, { orderId, userId });
  throw err;
}
```

## Quick Test

Test locally before deploying:

```bash
# Clone and install
git clone <repo-url> && cd pk-alert-hook
npm install

# Set up your webhook
cp examples/.env.example examples/.env
# Edit examples/.env with your real webhook URL

# Send 3 test alerts (error, warning, info)
npx tsx examples/basic.ts
```

Check your Google Chat space — you should see 3 cards within seconds.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `webhookUrl` | `string` | **required** | Google Chat incoming webhook URL |
| `environment` | `string` | **required** | Current environment (`production`, `staging`, etc.) |
| `allowedEnvs` | `string[]` | **required** | Only send alerts in these environments |
| `appName` | `string` | **required** | Shown in alert header |
| `version` | `string` | — | App version shown in footer |
| `maxStackLength` | `number` | `500` | Max characters for stack trace |
| `timezone` | `string` | `'UTC'` | IANA timezone string (e.g. `'Asia/Bangkok'`) |
| `rateLimitWindowMs` | `number` | `300000` | Dedup window in ms (default 5min) |
| `rateLimitEnabled` | `boolean` | `true` | Enable/disable rate limiting |
| `silent` | `boolean` | `false` | Suppress internal console warnings |
| `showPreviewText` | `boolean` | `true` | Show notification preview text above card (useful for desktop/mobile notifications, adds a text line above the card in chat) |

## API

### `AlertHook.init(config)`

Initialize with config. Validates with Zod — throws on invalid config. Call once at startup.

### `AlertHook.capture(error, context?)`

Capture an error. Fire-and-forget — never throws, never blocks your app.

```ts
AlertHook.capture(error, { userId: 'usr_123', route: '/api/orders' });
```

### `AlertHook.alert(message, context?, severity?)`

Send a manual alert. Defaults to `WARNING` severity.

```ts
import { Severity } from 'pk-alert-hook';

AlertHook.alert('Disk usage at 90%', { disk: '/dev/sda1' });
AlertHook.alert('Deploy complete', {}, Severity.INFO);
```

### `AlertHook.setGlobalContext(context)`

Set persistent context merged into every alert.

```ts
AlertHook.setGlobalContext({ region: 'us-east-1', service: 'payment-api' });
```

### `AlertHook.clearGlobalContext()`

Clear all global context.

### `AlertHook.flush()`

Await all pending alert sends. Call during graceful shutdown.

```ts
process.on('SIGTERM', async () => {
  await AlertHook.flush();
  process.exit(0);
});
```

### `AlertHook.destroy()`

Tear down the instance. Stops rate limiter, clears state.

## Rate Limiting

Two layers of protection to prevent flooding your Google Chat space.

### 1. Dedup Rate Limiter (per error)

Groups identical errors within a time window so the same crash doesn't spam your chat.

- Creates a fingerprint from error message + first stack frame
- First occurrence → sent immediately
- Same error within 5 minutes (default) → suppressed, counter increments
- After window expires → next occurrence sent with **"Occurred N times"** badge
- Different errors are always independent

```ts
// Change the dedup window
AlertHook.init({ ...config, rateLimitWindowMs: 600_000 }); // 10 minutes

// Disable dedup entirely (every error sends a message)
AlertHook.init({ ...config, rateLimitEnabled: false });
```

### 2. Global Send Throttle (per minute)

Google Chat enforces **60 messages/minute per space**. pk-alert-hook caps at **50/minute** (with 10 buffer) regardless of dedup settings.

- If 200 unique errors fire in 1 second → first 50 send, rest dropped
- Dropped alerts log a `console.warn` (unless `silent: true`)
- Sends resume automatically after the rolling minute window passes
- This limit is always active and cannot be disabled — it protects your webhook from being blocked by Google

## Safety Guarantees

- **Never breaks your app.** Every public method is wrapped in try-catch. If pk-alert-hook fails internally, it logs a warning and moves on.
- **Fire-and-forget.** `capture()` and `alert()` return void. Webhook calls happen in the background.
- **No memory leaks.** Promises self-clean after resolving. Rate limiter is capped at 1000 entries with automatic cleanup.
- **Only `init()` throws** — intentionally — so bad config fails fast at startup.

## Framework Examples

### Express

```ts
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  AlertHook.capture(err, { method: req.method, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});
```

### NestJS

```ts
@Catch()
export class AlertHookFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest();
    AlertHook.capture(exception, { method: req.method, path: req.url });
  }
}
```

### Next.js API Route

```ts
export async function POST(request: Request) {
  try {
    // ... handle request
  } catch (err) {
    AlertHook.capture(err, { route: 'POST /api/endpoint' });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

## Contributing

This is a personal project and a portfolio showcase. Contributions are not accepted — see [CONTRIBUTING.md](CONTRIBUTING.md) for details. You're welcome to use, fork, and learn from the code.

## License

MIT
