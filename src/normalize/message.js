// 事件归一化（SPEC §3 / E5）。

export const CONVERSATION_DM = 'dm';
export const CONVERSATION_GROUP = 'group';

/**
 * @typedef {Object} Resource
 * @property {string} type - image
 * @property {string} [downloadCode]
 */

/**
 * @typedef {Object} ParsedContent
 * @property {string} text
 * @property {Resource[]} resources
 * @property {string[]} mentions
 */

/** @returns {ParsedContent} */
export function parseContent(msgType, content, atUsers) {
  const resources = [];
  const mentions = [];
  let text = '';

  if (!content || typeof content !== 'object') {
    return { text: '', resources, mentions };
  }

  // DingTalk bot callback supports: text / richText / picture
  switch (msgType) {
    case 'text': {
      text = (content.content || '').trim();
      break;
    }
    case 'richText': {
      const parts = content.richText || [];
      const textParts = [];
      const seenCodes = new Set();
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (part.type === 'at') {
          if (Array.isArray(part.atUserIds)) {
            for (const id of part.atUserIds) mentions.push({ userId: id });
          }
          if (Array.isArray(part.atMobiles)) {
            for (const m of part.atMobiles) mentions.push({ userId: m, name: m });
          }
        } else if (part.type === 'picture') {
          // 对齐 lark channel-sdk 富文本附件区：段值即下载码；
          // 仅接受非空字符串，同一下载码单条消息内去重。
          const code = part.picture;
          if (typeof code === 'string' && code && !seenCodes.has(code)) {
            seenCodes.add(code);
            resources.push({ type: 'image', downloadCode: code });
          }
        } else if (part.type === 'file') {
          const code = part.downloadCode;
          if (typeof code === 'string' && code && !seenCodes.has(code)) {
            seenCodes.add(code);
            resources.push({
              type: 'file',
              downloadCode: code,
              fileName: typeof part.fileName === 'string' ? part.fileName : ''
            });
          }
        }
      }
      text = textParts.join('');
      break;
    }
    case 'picture': {
      resources.push({ type: 'image', downloadCode: content.downloadCode || '' });
      break;
    }
    case 'file': {
      const fileName = content.fileName || '';
      resources.push({ type: 'file', downloadCode: content.downloadCode || '', fileName });
      text = `[文件: ${fileName}]`;
      break;
    }
    case 'audio': {
      const fileName = content.fileName || '';
      resources.push({ type: 'audio', downloadCode: content.downloadCode || '', fileName, recognition: content.recognition || '' });
      text = content.recognition || '[语音消息]';
      break;
    }
    case 'video': {
      const fileName = content.fileName || '';
      resources.push({ type: 'video', downloadCode: content.downloadCode || '', fileName });
      text = '[视频]';
      break;
    }
    case 'markdown': {
      text = (content.text || '').trim();
      break;
    }
    case 'actionCard': {
      const title = content.title || '';
      const body = content.text || '';
      const urlParts = [];
      const itemList = content.actionUrlItemList || [];
      for (const item of itemList) {
        if (item.actionUrl) urlParts.push(item.actionUrl);
      }
      text = [title, body, ...urlParts].filter(Boolean).join('\n');
      break;
    }
    case 'interactiveCard': {
      const url = content.biz_custom_action_url || '';
      text = url ? `收到交互式卡片链接：${url}` : '';
      break;
    }
    case 'reply': {
      const body = content.text || '';
      const replied = content.repliedMsg || '';
      text = replied ? `${body}\n${replied}` : body;
      break;
    }
    default: {
      if (typeof content.content === 'string') {
        text = content.content.trim();
      }
      break;
    }
  }

  return { text, resources, mentions };
}

/** @returns {import('./types.js').IncomingMessage} */
export function normalizeIncoming(data) {
  const d = typeof data === 'string' ? JSON.parse(data) : data;
  const conversationType = d.conversationType === '1' ? CONVERSATION_DM : CONVERSATION_GROUP;
  const msgType = d.msgtype || 'text';

  let text;
  let resources = [];
  let mentions = [];

  if (msgType === 'text') {
    text = (d.text?.content || '').trim();
  } else {
    const parsed = parseContent(msgType, d.content, d.atUsers);
    text = parsed.text;
    resources = parsed.resources;
    mentions = parsed.mentions;
  }

  if (conversationType === CONVERSATION_GROUP && text.startsWith('@')) {
    const i = text.indexOf(' ');
    if (i >= 0) text = text.slice(i + 1).trim(); // 剥 @机器人 前缀
  }

  const atUsers = d.atUsers || [];
  let mentionAll = false;
  for (const u of atUsers) {
    if (u.staffId === 'all') {
      mentionAll = true;
    } else if (u.staffId) {
      mentions.push({ userId: u.staffId });
    }
  }

  return {
    conversationId: d.conversationId || '',
    conversationType,
    conversationTitle: d.conversationTitle || '',
    senderId: d.senderId || '',
    senderStaffId: d.senderStaffId || '',
    senderNick: d.senderNick || '',
    senderCorpId: d.senderCorpId || '',
    text,
    msgType,
    content: d.content ?? null,
    atUsers,
    resources,
    mentions,
    mentionAll,
    sessionWebhook: d.sessionWebhook || '',
    webhookExpiredAt: d.sessionWebhookExpiredTime || 0,
    msgId: d.msgId || '',
    createAt: d.createAt || 0,
    isAdmin: Boolean(d.isAdmin),
    isInAtList: Boolean(d.isInAtList),
    raw: d,
  };
}
