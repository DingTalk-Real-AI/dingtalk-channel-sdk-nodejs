# dingtalk-channel-sdk-nodejs

**English** | [简体中文](./README.zh-CN.md)

DingTalk Channel SDK (Node.js) — a conversation access layer decoupled from any agent runtime: Stream long connection, inbound event normalization, a unified safety pipeline, and streaming AI-card replies, all behind one high-level Channel.

Requires Node.js 18+.

## Install

```bash
npm install dingtalk-channel-sdk   # after release; locally: npm install github:DingTalk-Real-AI/dingtalk-channel-sdk-nodejs
```

## Minimal Example

```js
import { DingTalkChannel } from 'dingtalk-channel-sdk';

const ch = new DingTalkChannel({
  clientId: process.env.DD_CLIENT_ID,
  clientSecret: process.env.DD_CLIENT_SECRET,
});

ch.on('message', async (msg, reply) => {
  await reply.text(`received: ${msg.text}`);
});

await ch.start();   // blocks, auto-reconnects
```

`await ch.start()` establishes the Stream long connection and blocks (auto-reconnect); replies go through the sessionWebhook, no public ingress required.

## Highlights

- **Streaming AI-card replies**: `await reply.stream()` delivers a "typing" card immediately, `await s.append(token)` streams tokens (800ms throttle), `await s.finish()` freezes the card; orphan watchdog, text fallback on card failure, token-bucket rate limiting with QpsLimit backoff
- **Unified safety pipeline**: two-layer dedup (messageId + msgId), policy gate (per-group overrides / @-mention), per-chat serialization and batching, consecutive-media window merging
- **Outbound reliability**: structured error classification (`isRetryable()` / `isReplyTargetGone()`) for retry policies
- **Dual transport**: Stream (default) and HTTP mode (official signature verification built in)
- **livecheck**: one-command verification against the real environment

Streaming in three lines:

```js
const s = await reply.stream();
for await (const token of myLLM(msg.text)) await s.append(token);
await s.finish();
```

## Documentation

| Topic | Content |
|-------|---------|
| [SPEC.md](./SPEC.md) | Shared four-language contract and the E1–E10 acceptance checklist |
| [GUIDE.md](./GUIDE.md) | Integration guide: bring your agent into DMs and group chats |
| [OVERVIEW.md](./OVERVIEW.md) | Architecture layers and module overview |
| Advanced config | Policy / hooks / batching / outbound / HTTP mode (see below) |

## Examples

| Example | Description |
|---------|-------------|
| `example/echo.mjs` | Minimal echo bot |
| `example/fullflow.mjs` | Full feature: proactive send + media upload & embedding |
| `example/livecheck.mjs` | One-command live verification (`npm run live`) |

## Package Boundaries

Application code typically imports only the root package:

```js
import { DingTalkChannel } from 'dingtalk-channel-sdk';
```

Sub-modules (`normalize/` / `safety/` / `outbound/`) are internal layering and carry no compatibility promise.

## Advanced Config

| Option | Default | Description |
|--------|---------|-------------|
| `policyConfig` | allow all | Admission policy: @-mention requirement, group/sender allow-block lists, per-group overrides |
| `chatQueue` | enabled | Strict per-conversation serialization |
| `mediaBatch` | disabled | Merge consecutive pictures/files/audio/video within a window |
| `outbound` | — | Unified footer, before/after-send hooks |
| `ssrfAllowlist` | — | Exempt internal CDN download URLs |
| `transport` | `stream` | `http` = HTTP mode (`await ch.handleHTTPCallback(body, timestamp, sign)`) |
| `ch.on('reject')` | — | Reject-event callback (with reason) |

Proactive send: `await ch.sendText({ userId: 'staff-1' }, 'hello')` (groups use `conversationId`, @ mentions supported).

## Development

```bash
npm test         # 38 tests
```

Live check: `DD_CLIENT_ID=... DD_CLIENT_SECRET=... npm run live`

## License

MIT
