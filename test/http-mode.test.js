import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DingTalkChannel } from '../src/channel.js';
import { verifyHTTPSign } from '../src/http-mode.js';

const SECRET = 'sec';

function signFor(timestamp, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
}

function httpCallbackBody(msgId, text = 'hi') {
  return JSON.stringify({
    conversationId: 'cid-w',
    conversationType: '1',
    msgId,
    senderStaffId: 'staff-1',
    sessionWebhook: '',
    text: { content: text },
    isInAtList: true,
    msgtype: 'text',
  });
}

describe('http mode transport', () => {
  it('verifies sign per DingTalk protocol (s/ms compatible, window, constant-time)', () => {
    const ts = String(Date.now());
    const tsSec = String(Math.floor(Date.now() / 1000));
    verifyHTTPSign(SECRET, ts, signFor(ts));
    verifyHTTPSign(SECRET, tsSec, signFor(tsSec));
    assert.throws(() => verifyHTTPSign(SECRET, ts, signFor(ts, 'wrong')), /signature mismatch/);
    const old = String(Date.now() - 2 * 3600 * 1000);
    assert.throws(() => verifyHTTPSign(SECRET, old, signFor(old)), /tolerance/);
    verifyHTTPSign(SECRET, old, signFor(old), 0); // <=0 关闭窗口
  });

  it('dispatches http callback body through the shared pipeline and dedups retries', async () => {
    const ch = new DingTalkChannel({ clientId: 'id', clientSecret: SECRET });
    const calls = [];
    ch.on('message', async (msg) => calls.push(msg.text));

    const ts = String(Date.now());
    const sign = signFor(ts);
    const body = httpCallbackBody('w-1');
    await ch.handleHTTPCallback(body, ts, sign);
    await ch.handleHTTPCallback(body, ts, sign); // 重试重推 → 去重
    assert.deepEqual(calls, ['hi']);

    await assert.rejects(() => ch.handleHTTPCallback(body, ts, 'bad-sign'), /signature/);
    await assert.rejects(() => ch.handleHTTPCallback('{bad', ts, sign), /payload/);
    ch.close();
  });

  it('start() redirects to handleHTTPCallback in http mode', async () => {
    const ch = new DingTalkChannel({ clientId: 'id', clientSecret: SECRET, transport: 'http' });
    ch.on('message', async () => {});
    await assert.rejects(() => ch.start(), /handleHTTPCallback/);
    ch.close();
  });
});
