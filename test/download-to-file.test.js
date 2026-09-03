// downloadFileToFile 流式落盘单测（对齐 lark channel-sdk downloadResourceToFile）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DingTalkChannel } from '../src/channel.js';

const MEDIA = Buffer.from('dingtalk-media-bytes'.repeat(512));

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1.0/oauth2/accessToken') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accessToken: 'tok-1', expireIn: 7200 }));
    } else if (req.url === '/media.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(MEDIA);
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('downloadFileToFile streams to disk and keeps downloadFile working', async () => {
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ch = new DingTalkChannel({
      clientId: 'ding-test',
      clientSecret: 's',
      apiBase: base,
      ssrfAllowlist: ['127.0.0.1']
    });

    const dir = await mkdtemp(path.join(tmpdir(), 'larkport-'));
    const dest = path.join(dir, 'media.bin');
    const n = await ch.downloadFileToFile(`${base}/media.bin`, dest);
    assert.equal(n, MEDIA.length);
    assert.ok(await readFile(dest).then((b) => b.equals(MEDIA)));

    // 原有内存下载语义保持不变
    const buf = await ch.downloadFile(`${base}/media.bin`);
    assert.ok(Buffer.from(buf).equals(MEDIA));
  } finally {
    server.close();
  }
});

test('downloadFileToFile rejects missing parent dir without leaving files', async () => {
  const ch = new DingTalkChannel({
    clientId: 'a',
    clientSecret: 'b',
    ssrfAllowlist: ['127.0.0.1']
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'larkport-missing-'));
  const missing = path.join(dir, 'no-such-dir', 'media.bin');
  await assert.rejects(() => ch.downloadFileToFile('http://127.0.0.1:1/x', missing));
  assert.deepEqual(await readdir(dir), []);
});

test('downloadFileToFile surfaces non-200 status', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/media.bin') {
      res.writeHead(404);
      res.end('{}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ch = new DingTalkChannel({
      clientId: 'a',
      clientSecret: 'b',
      ssrfAllowlist: ['127.0.0.1']
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'larkport-404-'));
    await assert.rejects(
      () => ch.downloadFileToFile(`${base}/media.bin`, path.join(dir, 'x.bin')),
      /http 404/
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    server.close();
  }
});
