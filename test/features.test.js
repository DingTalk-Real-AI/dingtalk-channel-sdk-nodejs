import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DingTalkChannel } from '../src/channel.js';
import { ChatQueueConfig, MediaBatchConfig } from '../src/safety/chat-queue.js';
import { OutboundConfig, OutboundHooks } from '../src/config.js';
import { assertPublicUrl } from '../src/safety/ssrf-guard.js';
import { mergeMessages } from '../src/safety/batching.js';

const frame = (msgId, extra = {}) => ({
  headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm-' + msgId },
  data: JSON.stringify({
    conversationId: 'cid-1',
    conversationType: '2',
    msgId,
    senderStaffId: 'staff-1',
    isInAtList: true,
    msgtype: 'text',
    text: { content: 'hi' },
    ...extra,
  }),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('chat queue', () => {
  it('serializes same-conversation messages in order', async () => {
    const ch = new DingTalkChannel({ clientId: 'id', clientSecret: 'sec' });
    const order = [];
    ch.on('message', async (msg) => {
      await sleep(10);
      order.push(msg.msgId);
    });
    for (let i = 0; i < 3; i++) await ch.dispatchForTest(frame(`q-${i}`));
    assert.deepEqual(order, ['q-0', 'q-1', 'q-2']);
    ch.close();
  });

  it('disabled falls back to old sync path', async () => {
    const ch = new DingTalkChannel({ clientId: 'id', clientSecret: 'sec', chatQueue: new ChatQueueConfig({ enabled: false }) });
    const calls = [];
    ch.on('message', async (msg) => calls.push(msg.msgId));
    await ch.dispatchForTest(frame('d-1'));
    assert.deepEqual(calls, ['d-1']);
    ch.close();
  });

  it('batch flush merges media resources when enabled', async () => {
    const ch = new DingTalkChannel({
      clientId: 'id',
      clientSecret: 'sec',
      mediaBatch: new MediaBatchConfig({ enabled: true, delayMs: 50 }),
    });
    const got = [];
    ch.on('batchMessage', async (batched) => got.push(batched.message.resources), { batchConfig: { delayMs: 50 } });
    for (let i = 0; i < 2; i++) {
      await ch.dispatchForTest(frame(`img-${i}`, { msgtype: 'picture', content: { downloadCode: `c${i}` } }));
    }
    await ch.chatQueue.flushAll();
    assert.equal(got.length, 1);
    assert.equal(got[0].length, 2);
    ch.close();
  });
});

describe('ssrf allowlist', () => {
  it('wildcard and exact match bypass; others blocked', async () => {
    await assertPublicUrl('http://cdn.internal.corp/x', ['*.internal.corp']);
    await assertPublicUrl('http://internal.corp/x', ['internal.corp']);
    await assert.rejects(() => assertPublicUrl('http://other.corp/x', ['*.internal.corp']));
    await assert.rejects(() => assertPublicUrl('http://127.0.0.1/x', ['internal.corp']));
  });
});

describe('outbound hooks + footer', () => {
  it('beforeSend sees footer-appended payload; afterSend fires on failure', async () => {
    const seen = [];
    const out = new OutboundConfig({
      footer: 'AI 生成',
      hooks: new OutboundHooks({
        beforeSend: (kind, target, payload) => (seen.push(['before', kind, payload]), payload),
        afterSend: (kind, target, ok) => seen.push(['after', ok]),
      }),
    });
    const ch = new DingTalkChannel({ clientId: 'id', clientSecret: 'sec', outbound: out });
    const { Reply } = await import('../src/reply.js');
    const reply = new Reply({ conversationId: 'c1', sessionWebhook: 'http://127.0.0.1:1/hook' }, ch.cfg, ch.tokens, ch.cards, ch.oapi);
    await assert.rejects(() => reply.text('hello'));
    const before = seen.find((s) => s[0] === 'before');
    assert.ok(before && before[2].content.endsWith('AI 生成'));
    assert.ok(seen.some((s) => s[0] === 'after' && s[1] === false));
    ch.close();
  });
});

describe('mergeMessages', () => {
  it('merges text and dedupes resources', () => {
    const msgs = [
      { msgId: 'a', text: 't1', resources: [{ downloadCode: 'x' }], mentions: [] },
      { msgId: 'b', text: 't2', resources: [{ downloadCode: 'x' }, { downloadCode: 'y' }], mentions: [] },
    ];
    const m = mergeMessages(msgs);
    assert.equal(m.text, 't1\n\nt2');
    assert.equal(m.resources.length, 2);
  });
});
