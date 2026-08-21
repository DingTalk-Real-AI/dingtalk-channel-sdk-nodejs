import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIncoming } from '../src/normalize/message.js';

test('normalize richText: extract text + mentions', () => {
  const data = JSON.stringify({
    conversationId: 'cid-1',
    conversationType: '2',
    msgId: 'rt-1',
    senderStaffId: 'staff-1',
    senderNick: 'John',
    sessionWebhook: '',
    isInAtList: true,
    msgtype: 'richText',
    content: {
      richText: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
        { type: 'at', atUserIds: ['staff-2'] }
      ]
    }
  });
  const msg = normalizeIncoming(data);
  assert.equal(msg.text, 'hello world');
  assert.ok(msg.mentions.some(m => m.userId === 'staff-2'));
});

test('normalize picture: extract resource', () => {
  const data = JSON.stringify({
    conversationId: 'cid-1',
    conversationType: '2',
    msgId: 'pic-1',
    senderStaffId: 'staff-1',
    senderNick: 'John',
    sessionWebhook: '',
    isInAtList: true,
    msgtype: 'picture',
    content: { downloadCode: 'dc-abc123' }
  });
  const msg = normalizeIncoming(data);
  assert.equal(msg.resources.length, 1);
  assert.equal(msg.resources[0].type, 'image');
  assert.equal(msg.resources[0].downloadCode, 'dc-abc123');
});

test('normalize unknown type: default fallback', () => {
  const data = JSON.stringify({
    conversationId: 'cid-1',
    conversationType: '2',
    msgId: 'unk-1',
    senderStaffId: 'staff-1',
    senderNick: 'John',
    sessionWebhook: '',
    isInAtList: true,
    msgtype: 'someNewType',
    content: { content: 'fallback text' }
  });
  const msg = normalizeIncoming(data);
  assert.equal(msg.text, 'fallback text');
});

test('normalize file: extract resource and placeholder text', () => {
  const data = JSON.stringify({
    conversationId: 'cid-1',
    conversationType: '2',
    msgId: 'file-1',
    senderStaffId: 'staff-1',
    senderNick: 'John',
    sessionWebhook: '',
    isInAtList: true,
    msgtype: 'file',
    content: { downloadCode: 'dc-file-1', fileName: 'report.pdf' }
  });
  const msg = normalizeIncoming(data);
  assert.equal(msg.text, '[文件: report.pdf]');
  assert.equal(msg.resources.length, 1);
  assert.equal(msg.resources[0].type, 'file');
  assert.equal(msg.resources[0].downloadCode, 'dc-file-1');
  assert.equal(msg.resources[0].fileName, 'report.pdf');
});

test('normalize audio: use recognition as text', () => {
  const data = JSON.stringify({
    conversationId: 'cid-1',
    conversationType: '2',
    msgId: 'audio-1',
    senderStaffId: 'staff-1',
    senderNick: 'John',
    sessionWebhook: '',
    isInAtList: true,
    msgtype: 'audio',
    content: { downloadCode: 'dc-audio-1', fileName: 'voice.amr', recognition: '你好' }
  });
  const msg = normalizeIncoming(data);
  assert.equal(msg.text, '你好');
  assert.equal(msg.resources.length, 1);
  assert.equal(msg.resources[0].type, 'audio');
  assert.equal(msg.resources[0].downloadCode, 'dc-audio-1');
  assert.equal(msg.resources[0].fileName, 'voice.amr');
  assert.equal(msg.resources[0].recognition, '你好');
});

test('normalize video: extract resource and placeholder text', () => {
  const data = JSON.stringify({
    conversationId: 'cid-1',
    conversationType: '2',
    msgId: 'video-1',
    senderStaffId: 'staff-1',
    senderNick: 'John',
    sessionWebhook: '',
    isInAtList: true,
    msgtype: 'video',
    content: { downloadCode: 'dc-video-1', fileName: 'clip.mp4' }
  });
  const msg = normalizeIncoming(data);
  assert.equal(msg.text, '[视频]');
  assert.equal(msg.resources.length, 1);
  assert.equal(msg.resources[0].type, 'video');
  assert.equal(msg.resources[0].downloadCode, 'dc-video-1');
  assert.equal(msg.resources[0].fileName, 'clip.mp4');
});

test('normalize actionCard: text contains title and body', () => {
  const data = JSON.stringify({
    conversationId: 'cid-1',
    conversationType: '2',
    msgId: 'card-1',
    senderStaffId: 'staff-1',
    senderNick: 'John',
    sessionWebhook: '',
    isInAtList: true,
    msgtype: 'actionCard',
    content: {
      title: '会议通知',
      text: '今天下午3点开会',
      actionUrlItemList: [{ actionUrl: 'https://example.com/join' }]
    }
  });
  const msg = normalizeIncoming(data);
  assert.ok(msg.text.includes('会议通知'));
  assert.ok(msg.text.includes('今天下午3点开会'));
});
