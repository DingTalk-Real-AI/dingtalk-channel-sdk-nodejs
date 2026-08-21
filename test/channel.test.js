// 效果验收单测：E1–E6/E9/E10（不依赖真实钉钉）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DingTalkChannel } from '../src/index.js';

function startFakeAPI() {
  const state = {
    token: 0,
    create: 0,
    deliver: 0,
    instances: new Map(),
    streams: [],
    webhook: [],
    failCreate: false,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      const send = (v) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(v));
      };
      if (req.url.endsWith('/oauth2/accessToken')) {
        state.token++;
        return send({ accessToken: 'tok-1', expireIn: 7200 });
      }
      if (req.url === '/v1.0/card/instances' && req.method === 'POST') {
        state.create++;
        if (state.failCreate) {
          res.statusCode = 500;
          return send({ code: 'InternalError' });
        }
        return send({});
      }
      if (req.url === '/v1.0/card/instances/deliver') {
        state.deliver++;
        return send({});
      }
      if (req.url === '/v1.0/card/instances' && req.method === 'PUT') {
        state.instances.set(json.outTrackId, json.cardData?.cardParamMap?.msgContent || '');
        return send({});
      }
      if (req.url === '/v1.0/card/streaming') {
        state.streams.push(json);
        return send({});
      }
      if (req.url === '/webhook') {
        state.webhook.push(json);
        return send({ errcode: 0 });
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

function botFrame(messageId, msgId, text, webhook) {
  return {
    type: 'CALLBACK',
    headers: { topic: '/v1.0/im/bot/messages/get', messageId, contentType: 'application/json' },
    data: JSON.stringify({
      conversationId: 'cid-1',
      conversationType: '2',
      msgId,
      senderStaffId: 'staff-1',
      senderNick: 'John',
      sessionWebhook: webhook,
      text: { content: text },
      msgtype: 'text',
      isInAtList: true,
    }),
  };
}

const newChannel = (base, extra = {}) =>
  new DingTalkChannel({ clientId: 'ding-test', clientSecret: 's', apiBase: base, streamThrottleMs: 10, cardQps: 100, ...extra });

test('E6: 双层去重（messageId + msgId）', async () => {
  const { server, state, base } = await startFakeAPI();
  let calls = 0;
  const ch = newChannel(base);
  ch.on('message', async () => { calls++; });
  await ch.dispatchForTest(botFrame('m-1', 'b-1', 'hi', base + '/webhook'));
  await ch.dispatchForTest(botFrame('m-1', 'b-1', 'hi', base + '/webhook')); // 协议层重复
  await ch.dispatchForTest(botFrame('m-2', 'b-1', 'hi', base + '/webhook')); // 业务层重复
  await ch.dispatchForTest(botFrame('m-3', 'b-2', 'hi', base + '/webhook'));
  assert.equal(calls, 2);
  server.close();
});

test('E1-E3+E5: 流式生命周期与 @ 剥离', async () => {
  const { server, state, base } = await startFakeAPI();
  let gotText = '';
  const ch = newChannel(base);
  ch.on('message', async (msg, reply) => {
    gotText = msg.text;
    const s = await reply.stream();
    await s.append('Hello ');
    await s.append('World'); // 节流合并
    await new Promise((r) => setTimeout(r, 25));
    await s.append('!');
    await s.finish('');
  });
  await ch.dispatchForTest(botFrame('m-1', 'b-1', '@bot 你好', base + '/webhook'));

  assert.equal(gotText, '你好');
  assert.equal(state.create, 1);
  assert.equal(state.deliver, 1);
  assert.ok(state.streams.some((s) => s.isFinalize && s.content.includes('World')));
  assert.ok([...state.instances.values()].some((c) => c.includes('Hello')));
  server.close();
});

test('E4: 卡片创建失败 → finish 降级 webhook 文本', async () => {
  const { server, state, base } = await startFakeAPI();
  state.failCreate = true;
  const ch = newChannel(base);
  ch.on('message', async (msg, reply) => {
    const s = await reply.stream();
    await s.append('final answer');
    await s.finish('').catch(() => {});
  });
  await ch.dispatchForTest(botFrame('m-1', 'b-1', 'hi', base + '/webhook'));
  assert.ok(state.webhook.length >= 1);
  assert.equal(state.webhook.at(-1).msgKey, 'sampleText');
  assert.equal(JSON.parse(state.webhook.at(-1).msgParam).content, 'final answer');
  server.close();
});

test('E9: text/markdown/image 的 msgKey', async () => {
  const { server, state, base } = await startFakeAPI();
  const ch = newChannel(base);
  ch.on('message', async (msg, reply) => {
    await reply.text('plain');
    await reply.markdown('T', '# md');
    await reply.image('https://x/y.png');
  });
  await ch.dispatchForTest(botFrame('m-1', 'b-1', 'hi', base + '/webhook'));
  assert.deepEqual(state.webhook.map((w) => w.msgKey), ['sampleText', 'sampleMarkdown', 'sampleImageMsg']);
  server.close();
});


// 节流窗口内的 append 不丢弃，安排 trailing flush。
test('trailing flush delivers in-window content without finish', async () => {
  const { server, state, base } = await startFakeAPI();
  const ch = newChannel(base, { streamThrottleMs: 200 });
  ch.on('message', async (msg, reply) => {
    const s = await reply.stream();
    await s.append('first'); // 立即刷
    await s.append('chunk2'); // 窗口内 → trailing flush
  });
  await ch.dispatchForTest(botFrame('m-1', 'b-1', 'hi', base + '/webhook'));

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (state.streams.some((s2) => s2.content === 'firstchunk2')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(
    state.streams.some((s2) => s2.content === 'firstchunk2'),
    'trailing flush did not deliver in-window content',
  );
  server.close();
});
