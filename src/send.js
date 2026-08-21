// 主动发消息（不依赖入站消息）。
// API 形态与 dws 源码验证一致：单聊 oToMessages/batchSend；群聊 groupMessages/send（支持 @）。

/**
 * @typedef {{userId?: string, conversationId?: string, atUserIds?: string[], atDingtalkIds?: string[], atAll?: boolean}} SendTarget
 */

export class ProactiveSender {
  constructor(cfg, cards) {
    this.cfg = cfg;
    this.cards = cards; // CardClient（复用 token/QPS 限流/重试）
  }

  /** @param {SendTarget} target userId（单聊）与 conversationId（群聊）二选一 */
  async send(target, msgKey, msgParam) {
    // 出站钩子 + 统一页脚（OutboundConfig）
    const out = this.cfg.outbound;
    if (out) {
      if (out.footer) {
        const param = { ...msgParam };
        if (msgKey === 'sampleText' && typeof param.content === 'string') {
          param.content = param.content + '\n\n' + out.footer;
        } else if (msgKey === 'sampleMarkdown' && typeof param.text === 'string') {
          param.text = param.text + '\n\n---\n' + out.footer;
        }
        msgParam = param;
      }
      if (out.hooks && out.hooks.beforeSend) {
        const replaced = out.hooks.beforeSend('send', target.userId || target.conversationId || '', msgParam);
        if (replaced !== undefined && replaced !== null) msgParam = replaced;
      }
    }
    const targetId = target.userId || target.conversationId || '';
    const after = (ok, err) => {
      if (out && out.hooks && out.hooks.afterSend) out.hooks.afterSend('send', targetId, ok, err);
    };
    try {
      await this.#send(target, msgKey, msgParam);
      after(true, null);
    } catch (err) {
      after(false, err && err.message);
      throw err;
    }
  }

  async #send(target, msgKey, msgParam) {
    const param = JSON.stringify(msgParam); // msgParam 必须字符串化 JSON
    if (target.userId && !target.conversationId) {
      return this.cards.callPublic('POST', '/v1.0/robot/oToMessages/batchSend', {
        robotCode: this.cfg.clientId,
        userIds: [target.userId],
        msgKey,
        msgParam: param,
      });
    }
    if (target.conversationId && !target.userId) {
      const body = {
        robotCode: this.cfg.clientId,
        openConversationId: target.conversationId,
        msgKey,
        msgParam: param,
      };
      if (target.atUserIds?.length) body.atUserIds = target.atUserIds;
      if (target.atDingtalkIds?.length) body.atOpendingtalkIds = target.atDingtalkIds;
      if (target.atAll) body.isAtAll = true;
      return this.cards.callPublic('POST', '/v1.0/robot/groupMessages/send', body);
    }
    throw new Error('SendTarget: 恰好设置 userId（单聊）或 conversationId（群聊）之一');
  }

  sendText(target, content) {
    return this.send(target, 'sampleText', { content });
  }

  sendMarkdown(target, title, text) {
    return this.send(target, 'sampleMarkdown', { title: title || firstLineTitle(text), text });
  }

  /** 视频消息（sampleVideo，对齐官方 connector sendVideoProactive）。mediaId 均为带 @ 的 RawMediaID。 */
  sendVideo(target, rawVideoMediaId, rawPicMediaId, durationMs = 60000) {
    return this.#send(target, 'sampleVideo', {
      duration: String(durationMs),
      videoMediaId: rawVideoMediaId,
      videoType: 'mp4',
      picMediaId: rawPicMediaId,
    });
  }

  /** 音频消息（sampleAudio，对齐官方 connector sendAudioProactive）。 */
  sendAudio(target, rawMediaId, durationMs = 60000) {
    return this.#send(target, 'sampleAudio', { mediaId: rawMediaId, duration: String(durationMs) });
  }

  sendImage(target, imageUrl) {
    return this.#send(target, 'sampleImageMsg', { photoURL: imageUrl });
  }
}

function firstLineTitle(text) {
  for (const line of String(text || '').split('\n')) {
    const t = line.replace(/^[#*->\s]+/, '');
    if (t) return t.slice(0, 20);
  }
  return 'Message';
}
