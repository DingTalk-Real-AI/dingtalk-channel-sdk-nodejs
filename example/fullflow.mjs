// 真机全流程测试：被动回复 + 媒体上传 + 主动发消息。
// 用法：DD_CLIENT_ID=... DD_CLIENT_SECRET=... node example/fullflow.mjs
import { DingTalkChannel } from '../src/index.js';

let steps = 0;
const pass = (name) => { steps++; console.log(`✅ PASS ${name}`); };
const fail = (name, err) => {
  console.error(`❌ FAIL ${name}: ${err?.message || err}`);
  process.exit(1);
};

// 8x8 红色 PNG（最小合法图片）
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQwAHxcCAmXfLkIAAAAASUVORK5CYII=',
  'base64',
);

const ch = new DingTalkChannel({
  clientId: process.env.DD_CLIENT_ID,
  clientSecret: process.env.DD_CLIENT_SECRET,
});
if (!ch.cfg.clientId || !ch.cfg.clientSecret) {
  console.error('需要环境变量 DD_CLIENT_ID / DD_CLIENT_SECRET');
  process.exit(2);
}

ch.on('message', async (msg, reply) => {
  try {
    console.log(`   收到消息: "${msg.text}" from ${msg.senderNick} (${msg.conversationType})`);
    pass(`① stream 消息接收 (msgId=${msg.msgId})`);

    await reply.text('fullflow: 文本回复 ok');
    pass('② webhook 文本回复');

    const s = await reply.stream();
    if (!s.cardDelivered) fail('③a 卡片创建/投递（降级）', new Error('card not delivered'));
    pass('③a 卡片创建+投递 (E1)');

    const media = await reply.uploadMedia('image', 'fullflow.png', tinyPng, 'image/png');
    pass(`③d 媒体上传 mediaId=${media.mediaId}`);

    const content = `# fullflow 全流程\n\n- 会话: \`${msg.conversationType}\`\n- 来自: ${msg.senderNick}\n\n下面是刚上传的图片：\n\n`;
    for (const t of content) {
      await s.append(t);
      await new Promise((r) => setTimeout(r, 10));
    }
    await s.finish(content + `![uploaded](${media.downloadUrl})\n`);
    pass('③e 流式卡片+图片内嵌收口 (E2/E3/E9)');

    await ch.sendText({ userId: msg.senderStaffId }, 'fullflow: 主动单聊文本 (SendText/batchSend)');
    pass('④a 主动单聊 SendText (batchSend)');
    await ch.sendMarkdown({ userId: msg.senderStaffId }, '主动通知', '**fullflow** 主动单聊 Markdown');
    pass('④b 主动单聊 SendMarkdown');

    if (msg.conversationType === 'group') {
      await ch.sendMarkdown(
        { conversationId: msg.conversationId, atUserIds: [msg.senderStaffId] },
        '群通知',
        '@你 fullflow 群发测试 (groupMessages/send)',
      );
      pass('⑤ 群发 SendMarkdown+@');
    } else {
      console.log('   （单聊会话：⑤ 群发@用例跳过——把机器人拉进群 @它 再跑一次可测）');
    }

    console.log(`\n🎉 全流程完成：${steps} 步通过（主动消息请看钉钉会话）。`);
    setTimeout(() => ch.close(), 2000);
  } catch (err) {
    fail('fullflow', err);
  }
});

console.log('== fullflow(node)：给机器人发一条消息 ==');
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
await ch.start(controller.signal);
