// downloadFileToFile 流式落盘单测。

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

    const dir = await mkdtemp(path.join(tmpdir(), 'dingtalk-'));
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
  const dir = await mkdtemp(path.join(tmpdir(), 'dingtalk-missing-'));
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
    const dir = await mkdtemp(path.join(tmpdir(), 'dingtalk-404-'));
    await assert.rejects(
      () => ch.downloadFileToFile(`${base}/media.bin`, path.join(dir, 'x.bin')),
      /http 404/
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    server.close();
  }
});

test('downloadFileToFile concurrent downloads do not collide on temp files', async () => {
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ch = new DingTalkChannel({
      clientId: 'ding-test',
      clientSecret: 's',
      apiBase: base,
      ssrfAllowlist: ['127.0.0.1']
    });

    const dir = await mkdtemp(path.join(tmpdir(), 'dingtalk-concurrent-'));
    const dest = path.join(dir, 'media.bin');
    // 并发写入同一目标文件，测试随机后缀避免冲突
    await Promise.all([
      ch.downloadFileToFile(`${base}/media.bin`, dest),
      ch.downloadFileToFile(`${base}/media.bin`, dest)
    ]);
    assert.equal((await readFile(dest)).length, MEDIA.length);
  } finally {
    server.close();
  }
});

test('downloadFile SSRF redirect bypass is blocked', async () => {
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('internal-secret');
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));

  const redirectServer = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetServer.address().port}/secret` });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));

  try {
    const ch = new DingTalkChannel({
      clientId: 'a',
      clientSecret: 'b',
      ssrfAllowlist: [`127.0.0.1:${redirectServer.address().port}`]
    });
    // 重定向到 targetServer（不在白名单），应被拦截
    await assert.rejects(
      () => ch.downloadFile(`http://127.0.0.1:${redirectServer.address().port}/redirect`),
      /SSRF/i
    );
  } finally {
    redirectServer.close();
    targetServer.close();
  }
});
