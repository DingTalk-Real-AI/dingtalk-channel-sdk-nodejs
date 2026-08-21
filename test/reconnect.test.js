// E8 回归：服务端下发 SYSTEM/disconnect 后必须重连（而非整体退出）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DingTalkChannel } from '../src/index.js';

test('stream reconnects after SYSTEM/disconnect', async () => {
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;

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
      connections += 1;
      if (connections === 1) {
        ws.send(JSON.stringify({
          type: 'SYSTEM',
          headers: { topic: 'disconnect', messageId: 'm-d' },
        }));
        ws.on('message', () => ws.close()); // 收到 ACK 后关闭
      } else {
        ws.send(JSON.stringify({
          type: 'CALLBACK',
          headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm-r', contentType: 'application/json' },
          data: JSON.stringify({ text: { content: 'after-reconnect' }, msgId: 'b-r', conversationId: 'cid', conversationType: '1', sessionWebhook: '' }),
        }));
        ws.on('message', () => ws.close());
      }
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
  ch.on('message', async (msg) => got.push(msg.text));

  const runPromise = ch.start(); // 后台运行（start 阻塞直到 close）
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (got.length > 0) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 8000);
  });

  ch.close();
  assert.deepEqual(got, ['after-reconnect']);
  assert.ok(connections >= 2, `expected >=2 connections, got ${connections}`);
  wss.close();
  server.close();
});
