import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DwsA2UIClient, DingTalkChannel, serializeA2UIMessages } from '../src/index.js';

const message = { version: 'v1.0', updateDataModel: { surfaceId: 'sdk-card', path: '/text', value: '中文、引号"与 $(echo test) `test`' } };

async function fixture(t, response = { ok: true, outcome: 'success', data: { success: true, result: { bizId: 'server-biz' } } }, mode = 'ok', timeoutMs = 5000) {
  const dir = await mkdtemp(path.join(process.cwd(), 'test', '.a2ui-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, '模拟 dws.mjs');
  const trace = path.join(dir, 'trace.jsonl');
  await writeFile(script, `import { appendFileSync } from 'node:fs';
const [trace, response, mode, ...args] = process.argv.slice(2);
appendFileSync(trace, JSON.stringify(args) + '\\n');
if (mode === 'hang') await new Promise(r => setTimeout(r, 10000));
if (mode === 'fail') { process.stderr.write('不应暴露的凭据占位符'); process.exit(2); }
process.stdout.write(response);
`);
  const client = new DwsA2UIClient({ command: [process.execPath, script, trace, typeof response === 'string' ? response : JSON.stringify(response), mode], profile: 'corp:user', timeoutMs });
  return { client, calls: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('A2UI 消息对象和字符串均保留语义，只序列化一层字符串数组', () => {
  const encoded = JSON.stringify(message);
  const strings = JSON.parse(serializeA2UIMessages([message, encoded]));
  assert.deepEqual(strings.map(JSON.parse), [message, message]);
  assert.equal(strings[1], encoded);
});

test('A2UI 无效信封和超大参数在执行前拒绝', () => {
  for (const value of [[], {}, ['not-json'], [null], [{ version: 'v0.8' }], [{ version: 'v1.0' }], [{ version: 'v1.0', deleteSurface: { surfaceId: '' } }], [{ ...message, deleteSurface: { surfaceId: 'x' } }]]) {
    assert.throws(() => serializeA2UIMessages(value));
  }
  assert.throws(() => serializeA2UIMessages([{ ...message, updateDataModel: { ...message.updateDataModel, value: '中'.repeat(24000) } }]), /64 KiB/);
  assert.throws(() => serializeA2UIMessages([{ ...message, updateDataModel: { ...message.updateDataModel, value: NaN } }]), /有效 JSON/);
});

test('Channel 经显式通道发送单聊、群聊并完成原卡片，不使用机器人 Token', async (t) => {
  const { client, calls } = await fixture(t);
  const ch = new DingTalkChannel({ clientId: 'unused', clientSecret: 'unused', a2uiClient: client });
  t.after(() => ch.close());
  const result = await ch.sendA2UICard({ openDingTalkId: 'D-user' }, [message]);
  assert.equal(result.bizId, 'server-biz');
  assert.equal(result.updateWarning, undefined);
  assert.equal(result.receipt.data.result.bizId, 'server-biz');
  await ch.sendA2UICard({ conversationId: '--group-value' }, [message]);
  await ch.updateA2UICard(result.bizId, [message], '3');
  const argv = await calls();
  assert.equal(argv.length, 3);
  assert.ok(argv[0].includes('--open-dingtalk-id=D-user'));
  assert.ok(argv[1].includes('--conversation-id=--group-value'));
  assert.ok(argv[2].includes('--biz-id=server-biz'));
  assert.ok(argv[2].includes('--flow-status=FINISH'));
  for (const args of argv) {
    assert.ok(args.includes('--profile=corp:user'));
    assert.ok(args.includes('--format=json'));
    assert.ok(args.includes('--yes'));
    assert.ok(!args.some(arg => arg.includes('client-secret')));
    const content = args.find(arg => arg.startsWith('--content=')).slice('--content='.length);
    assert.deepEqual(JSON.parse(content).map(JSON.parse), [message]);
  }
});

test('未启用 A2UI 时明确拒绝，不启动 DWS', () => {
  const ch = new DingTalkChannel({ clientId: 'unused', clientSecret: 'unused' });
  try {
    assert.throws(() => ch.sendA2UICard({ conversationId: 'cid' }, [message]), /a2uiClient/);
    assert.throws(() => ch.updateA2UICard('biz', [message], 'FINISH'), /a2uiClient/);
  } finally { ch.close(); }
});

test('接收目标、bizId 和流转状态校验不执行子进程', async () => {
  assert.throws(() => new DwsA2UIClient({ profile: 'corp:user,other:user' }), /一个 DWS Profile/);
  const client = new DwsA2UIClient({ command: ['不存在的 dws'] });
  for (const target of [{}, { userId: 'staff' }, { conversationId: 'cid', atAll: true }, { conversationId: 'cid', openDingTalkId: 'D-user' }, { openDingTalkId: '' }]) {
    await assert.rejects(client.sendCard(target, [message]), /target|标识/);
  }
  await assert.rejects(client.updateCard('', [message], 'FINISH'), /bizId/);
  await assert.rejects(client.updateCard('biz', [message], 'unknown'), /flowStatus/);
});

test('仅有请求侧 bizCardId 时保留回执与警告，不伪造 bizId 或重发', async (t) => {
  const { client, calls } = await fixture(t, { success: true, result: { bizCardId: 'request-only', openTaskId: 'task' } });
  const result = await client.sendCard({ conversationId: 'cid' }, [message]);
  assert.equal(result.bizId, undefined);
  assert.match(result.updateWarning, /不要自动重发/);
  assert.equal(result.receipt.result.bizCardId, 'request-only');
  assert.equal((await calls()).length, 1);
});

test('业务失败、进程失败和非 JSON 回执不当作成功，也不泄露 stderr', async (t) => {
  for (const [response, mode] of [[{ success: false }, 'ok'], [{ success: true, result: { success: false } }, 'ok'], ['not-json', 'ok'], [{}, 'ok'], [{ result: { bizId: 'unconfirmed' } }, 'ok'], [{ ok: true, outcome: 'success', dry_run: true }, 'ok'], [{}, 'fail']]) {
    const { client, calls } = await fixture(t, response, mode);
    await assert.rejects(client.sendCard({ conversationId: 'cid' }, [message]), error => !error.message.includes('不应暴露'));
    assert.equal((await calls()).length, 1);
  }
});

test('DWS 超时终止子进程，并明确提示发送结果未知', async (t) => {
  const { client } = await fixture(t, {}, 'hang', 200);
  await assert.rejects(client.sendCard({ conversationId: 'cid' }, [message]), /结果可能未知/);
});
