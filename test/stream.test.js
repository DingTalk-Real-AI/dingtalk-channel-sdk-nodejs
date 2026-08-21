// E8 + SPEC §2：假网关全链路（open → wss → 帧分发 → ACK / SYSTEM pong）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DingTalkChannel } from '../src/index.js';

test('stream e2e: 消息分发 + ACK + SYSTEM pong', async () => {
  const wss = new WebSocketServer({ noServer: true });
  const acks = [];
  let wsClient = null;

  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/v1.0/gateway/connections/open')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ endpoint: `ws://127.0.0.1:${server.address().port}`, ticket: 't-1' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wsClient = ws;
      ws.on('message', (raw) => {
        acks.push(JSON.parse(raw.toString()));
        if (acks.length === 2) finish();
      });
      ws.send(
        JSON.stringify({
          type: 'CALLBACK',
          headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm-9', contentType: 'application/json' },
          data: JSON.stringify({ text: { content: 'ping' }, msgId: 'b-9', conversationId: 'cid', conversationType: '1', sessionWebhook: '' }),
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'SYSTEM',
          headers: { topic: 'ping', messageId: 'm-ping' },
          data: 'keepalive',
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, r));

  const ch = new DingTalkChannel({
    clientId: 'ding-test',
    clientSecret: 's',
    apiBase: `http://127.0.0.1:${server.address().port}`,
    keepAliveIdleMs: 10_000,
    streamThrottleMs: 5,
    cardQps: 100,
  });
  const got = [];
  ch.on('message', async (msg) => {
    got.push(msg.text);
  });

  let done;
  const finish = () => {
    if (done) done();
  };
  const timeout = setTimeout(() => finish(), 3000);

  const runPromise = ch.start();
  await new Promise((r) => (done = r));
  clearTimeout(timeout);
  ch.close();

  assert.deepEqual(got, ['ping']);
  assert.equal(acks.length, 2);
  for (const a of acks) {
    assert.equal(a.code, 200);
    assert.ok(a.headers.messageId);
  }
  assert.ok(acks.some((a) => a.data === 'keepalive'), 'SYSTEM ping 未回显 pong');

  wss.close();
  server.close();
  await runPromise.catch(() => {});
});
