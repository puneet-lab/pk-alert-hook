# Google Chat Webhook Setup Guide

Step-by-step guide to create a Google Chat webhook for pk-alert-hook.

## 1. Create a Google Chat Space (or use existing)

1. Open [Google Chat](https://chat.google.com)
2. Click **"New chat"** → **"Create a space"**
3. Name it something like `Alerts — Production` or `Error Alerts`
4. Choose **"Space"** (not group conversation)
5. Click **"Create"**

> Tip: Create separate spaces for different environments (production, staging) so alerts don't mix.

## 2. Create an Incoming Webhook

1. Open the space you created
2. Click the **space name** at the top to open settings
3. Click **"Apps & integrations"**
4. Click **"Manage webhooks"**
5. Click **"Add another"** (or create first webhook)
6. Give it a name: `pk-alert-hook` (this shows as the sender name)
7. Optionally set an avatar URL
8. Click **"Save"**
9. **Copy the webhook URL** — it looks like:
   ```
   https://chat.googleapis.com/v1/spaces/AAAA.../messages?key=AIza...&token=...
   ```

> **Security:** This URL contains authentication tokens. Treat it like a password. Never commit it to git.

## 3. Add to Your Project

Add the webhook URL to your `.env` file:

```env
PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/AAAA.../messages?key=AIza...&token=...
```

Make sure `.env` is in your `.gitignore`.

## 4. Test It

```ts
import { AlertHook } from 'pk-alert-hook';

AlertHook.init({
  webhookUrl: process.env.PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL!,
  environment: 'production',
  allowedEnvs: ['production'],
  appName: 'my-app',
});

AlertHook.alert('Test alert — pk-alert-hook is working!');
await AlertHook.flush();
```

You should see a card message in your Google Chat space within seconds.

## Google Workspace Requirements

- Google Workspace account (free Google accounts may have limited Chat API access)
- Webhooks must be enabled by your Workspace admin
- If you don't see "Manage webhooks", ask your admin to enable:
  **Admin Console → Apps → Google Workspace → Google Chat → Manage webhooks: ON**

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Manage webhooks" not visible | Workspace admin needs to enable webhooks |
| 403 Forbidden | Webhook URL expired or was deleted — create a new one |
| 404 Not Found | Space was deleted or URL is malformed |
| Messages not appearing | Check `allowedEnvs` matches your `environment` value |
| No errors but no messages | Library is silent in non-allowed envs — check `NODE_ENV` |

## Webhook Limits

Google Chat webhooks have rate limits:
- **60 messages per minute** per space
- pk-alert-hook's built-in rate limiter (5min window) keeps you well under this
- If you disable rate limiting (`rateLimitEnabled: false`), you may hit Google's limit during error storms
