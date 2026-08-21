// 真实钉钉联调一键验证（live check）。
//
// 用法：DD_CLIENT_ID=ding... DD_CLIENT_SECRET=... [DD_UPLOAD_FILE=/path/img.png] node example/livecheck.mjs
//
// 流程：① 配置加载 ② Stream 连接 ③ 收消息 ④ 文本回复（token 链路）
// ⑤ 流式 AI 卡片全生命周期（E1–E3）⑥（可选）媒体上传。每步 PASS/FAIL。

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DingTalkChannel } from '../src/index.js';

let steps = 0;
const pass = (name) => {
  steps++;
  console.log(`✅ PASS ${name}`);
};
const fail = (name, err) => {
  console.error(`❌ FAIL ${name}: ${err?.message || err}`);
  console.error(`完成 ${steps} 步后失败。凭据/应用配置请核对：https://open-dev.dingtalk.com`);
  process.exit(1);
};

const clientId = process.env.DD_CLIENT_ID;
const clientSecret = process.env.DD_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('需要环境变量 DD_CLIENT_ID / DD_CLIENT_SECRET');
  process.exit(2);
}

console.log('== dingtalk-channel-sdk-nodejs livecheck ==');
pass(`config loaded (clientId=${clientId.slice(0, 8)}...)`);

const ch = new DingTalkChannel({
  clientId,
  clientSecret,
  debug: (fmt, ...args) => console.log('[debug]', fmt, ...args),
});

ch.on('message', async (msg, reply) => {
  try {
    console.log(`   收到消息: "${msg.text}" from ${msg.senderNick} (${msg.conversationType})`);
    pass(`stream message received (msgId=${msg.msgId})`);

    await reply.text('livecheck: text reply ok'); // 隐含新版 token
    pass('text reply via sessionWebhook (token path verified)');

    const s = await reply.stream();
    pass('AI card created & delivered (E1)');

    let content =
      `# livecheck 流式验证\n\n` +
      `- 单聊/群聊: \`${msg.conversationType}\`\n` +
      `- 来自: ${msg.senderNick}\n\n`;

    const uploadFile = process.env.DD_UPLOAD_FILE;
    if (uploadFile) {
      let type = 'file';
      if (/\.(png|jpe?g)$/i.test(uploadFile)) type = 'image';
      const media = await reply.uploadMedia(type, basename(uploadFile), readFileSync(uploadFile));
      pass(`media upload, mediaId=${media.mediaId}`);
      content += type === 'image' ? `![uploaded](${media.downloadUrl})\n` : `- 上传文件 mediaId: \`${media.mediaId}\`\n`;
    }

    for (const t of content) {
      await s.append(t);
      await new Promise((r) => setTimeout(r, 15));
    }
    await s.finish(content);
    pass('AI card streaming lifecycle (E2/E3)');

    console.log(`\n🎉 全部 ${steps} 步通过：真实钉钉联调验证成功。`);
    setTimeout(() => ch.close(), 2000);
  } catch (err) {
    fail('livecheck', err);
  }
});

console.log('waiting for a message — 在钉钉里给机器人发一句话...');
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
try {
  await ch.start(controller.signal);
} catch (err) {
  fail('stream connect', err);
}
