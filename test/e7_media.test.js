// E7 卡片回调 + E9 媒体上传 单测。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DingTalkChannel } from '../src/index.js';

const TOPIC_CARD = '/v1.0/card/instances/callback';

test('E7: 卡片回调帧分发到 on(cardAction)', async () => {
  const ch = new DingTalkChannel({ clientId: 'a', clientSecret: 'b', cardQps: 100 });
  const got = [];
  ch.on('cardAction', async (action) => {
    got.push(action);
  });
  await ch.dispatchForTest({
    type: 'CALLBACK',
    headers: { topic: TOPIC_CARD, messageId: 'm-c1' },
    data: JSON.stringify({ outTrackId: 'card_123', userId: 'u-1', dataContent: { action: 'confirm' } }),
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].outTrackId, 'card_123');
  assert.equal(got[0].userId, 'u-1');
  assert.equal(got[0].dataContent.action, 'confirm');
});

test('E7: 注册 cardAction 后订阅列表包含卡片 topic', async () => {
  const ch = new DingTalkChannel({ clientId: 'a', clientSecret: 'b', cardQps: 100 });
  assert.equal(ch.conn.wantCardTopic, false);
  ch.on('cardAction', async () => {});
  assert.equal(ch.conn.wantCardTopic, true);

  const subs = ch.conn.buildSubscriptions();
  assert.ok(subs.some((s) => s.type === 'CALLBACK' && s.topic === TOPIC_CARD));
  assert.ok(subs.some((s) => s.type === 'CALLBACK' && s.topic === '/v1.0/im/bot/messages/get'));
  assert.ok(subs.some((s) => s.type === 'SYSTEM' && s.topic === 'ping'));
});

test('E9: 媒体上传（gettoken + multipart，mediaId 去 @）', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ url: req.url, contentType: req.headers['content-type'], body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1.0/oauth2/accessToken') {
        res.end(JSON.stringify({ accessToken: 'new-tok', expireIn: 7200 }));
      } else if (req.url === '/v1.0/robot/robotInfo') {
        res.end(JSON.stringify({ robotCode: 'ding-test', robotName: 'TestBot' }));
      } else if (req.url.startsWith('/gettoken')) {
        res.end(JSON.stringify({ errcode: 0, access_token: 'oapi-tok', expires_in: 7200 }));
      } else if (req.url.startsWith('/media/upload')) {
        assert.match(req.headers['content-type'], /^multipart\/form-data/);
        assert.ok(body.includes('name="media"')); // 字段名必须是 media
        assert.ok(body.includes('fake-jpeg-bytes'));
        res.end(JSON.stringify({ errcode: 0, media_id: '@MEDIA_9', type: 'image' }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ch = new DingTalkChannel({
    clientId: 'ding-test',
    clientSecret: 's',
    apiBase: base,
    oapiBase: base,
    streamThrottleMs: 5,
    cardQps: 100,
  });
  let result;
  ch.on('message', async (msg, reply) => {
    result = await reply.uploadMedia('image', 'a.jpg', 'fake-jpeg-bytes');
  });
  await ch.dispatchForTest({
    type: 'CALLBACK',
    headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm-1' },
    data: JSON.stringify({ msgId: 'b-1', sessionWebhook: '', isInAtList: true }),
  });

  // Find the gettoken and upload calls (may not be first due to bot identity calls)
  const gettokenCall = calls.find((c) => c.url.includes('appkey=ding-test'));
  const uploadCall = calls.find((c) => c.url.includes('access_token=oapi-tok'));
  assert.ok(gettokenCall, 'gettoken call not found');
  assert.ok(uploadCall, 'upload call not found');
  assert.ok(uploadCall.url.includes('type=image'));
  assert.equal(result.mediaId, 'MEDIA_9'); // 去前导 @
  server.close();
});

// 主动发消息：单聊 batchSend / 群聊 groupMessages/send（含 @）。
test('proactive send: dm batchSend + group send with @', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ path: req.url, body: body ? JSON.parse(body) : {} });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/oauth2/accessToken')) {
        res.end(JSON.stringify({ accessToken: 'tok', expireIn: 7200 }));
      } else {
        res.end('{}');
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ch = new DingTalkChannel({ clientId: 'ding-test', clientSecret: 's', apiBase: base, streamThrottleMs: 5, cardQps: 100 });

  await ch.sendText({ userId: 'staff-1' }, 'hello');
  await ch.sendMarkdown({ conversationId: 'cid-g', atUserIds: ['u1', 'u2'] }, '', '# hello');
  await assert.rejects(() => ch.sendText({}, 'x'), /恰好设置/);

  const send1 = calls.find((c) => c.path === '/v1.0/robot/oToMessages/batchSend');
  const send2 = calls.find((c) => c.path === '/v1.0/robot/groupMessages/send');
  assert.ok(send1, 'batchSend not called');
  assert.deepEqual(send1.body.userIds, ['staff-1']);
  assert.equal(typeof send1.body.msgParam, 'string');
  assert.ok(send2, 'groupMessages/send not called');
  assert.deepEqual(send2.body.atUserIds, ['u1', 'u2']);
  assert.equal(send2.body.openConversationId, 'cid-g');
  server.close();
});
