# ONEBOX — Starter Project

AI-free public platform with private team workspaces.
Stack: React + TypeScript + Vite, Cloudflare Workers, D1, R2-ready, Telegram Bot API.

## Current starter scope
- Telegram Mini App authentication with server-side initData validation.
- Basic React dashboard.
- Worker API: health, profile, personal notes, workspaces, QR metadata, dynamic QR redirect.
- Telegram webhook: /start, /app, /help.
- D1 schema and initial migration.
- Cron placeholder for reminder delivery.
- QR rendering in browser using `qrcode.react`.

This is a foundation, not yet the complete production product. Team invitations, granular permissions, rich-text editing,
bulk ZIP, analytics dashboards, file uploads and reminder scheduling are planned for subsequent implementation stages.

## Requirements
- Node.js 20+
- Telegram bot token from @BotFather
- Cloudflare account
- GitHub account

## Local setup
1. Install dependencies:
   `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and fill secrets.
3. Create D1 database and update `database_id` in `apps/worker/wrangler.toml`.
4. Apply migration:
   `npx wrangler d1 migrations apply onebox-db --local`
5. Start frontend:
   `npm run dev`
6. Start Worker separately:
   `npm run dev:worker`

The frontend expects the Worker at `http://127.0.0.1:8787`.
For local browser testing outside Telegram, set `VITE_DEMO_MODE=true`. Demo mode is only for local development.

## Cloudflare deployment overview
- Deploy Worker from `apps/worker`.
- Deploy Vite frontend to Cloudflare Pages.
- Set Worker secrets using `wrangler secret put`.
- Configure Telegram webhook to `https://YOUR_WORKER_DOMAIN/telegram/webhook`.
- Set Mini App URL in BotFather to the deployed Pages URL.
- Set `WEB_APP_URL` and `API_BASE_URL` in the frontend environment.

Never commit `.dev.vars`, bot tokens, JWT secrets, or production credentials.

## Important security notes
- Telegram `initData` is verified on the Worker using Telegram's documented HMAC process.
- Never trust a Telegram user ID supplied by the browser.
- All private data access must be authorized on the server.
- Before public launch, add rate limiting, abuse controls, data export/deletion, monitoring, backup strategy and full permission tests.
