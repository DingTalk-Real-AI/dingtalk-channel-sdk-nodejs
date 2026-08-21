// 演示 E1–E3：流式打字机回复（假 LLM 每 15ms 吐一个字符）。
// 运行：DD_CLIENT_ID=xxx DD_CLIENT_SECRET=xxx node example/echo.mjs
import { DingTalkChannel } from '../src/index.js';

const cfg = {
  clientId: process.env.DD_CLIENT_ID,
  clientSecret: process.env.DD_CLIENT_SECRET,
  debug: (fmt, ...args) => console.log('[debug]', fmt, ...args),
};

if (!cfg.clientId || !cfg.clientSecret) {
  console.error('需要环境变量 DD_CLIENT_ID / DD_CLIENT_SECRET');
  process.exit(1);
}

const ch = new DingTalkChannel(cfg);

ch.on('message', async (msg, reply) => {
  const s = await reply.stream(); // E1：立即出"输入中"卡片

  const answer =
    `**收到：${msg.text}**\n\n` +
    `- 单聊/群聊: \`${msg.conversationType}\`\n` +
    `- 发送者: ${msg.senderNick}\n` +
    '```js\nconsole.log("hello dingtalk channel")\n```';

  for (const ch_ of answer) { // 假流式
    await s.append(ch_);
    await new Promise((r) => setTimeout(r, 15));
  }
  await s.finish(answer); // E3：终帧 + FINISHED
});

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
console.log('channel started, waiting for messages...');
await ch.start(controller.signal);
