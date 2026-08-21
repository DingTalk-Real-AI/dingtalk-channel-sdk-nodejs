// Reply：sessionWebhook 回复 + AI 卡片流式（SPEC §4）。

import { CardStreamer } from './card.js';

const errLimLast = new Map();
function errorCooldownPass(key, cooldownMs) {
  if (!cooldownMs || cooldownMs <= 0) return true;
  const now = Date.now();
  const t = errLimLast.get(key);
  if (t && now - t < cooldownMs) return false;
  errLimLast.set(key, now);
  return true;
}

export class Reply {
  constructor(msg, cfg, tokens, cards, oapi) {
    this.msg = msg;
    this.cfg = cfg;
    this.tokens = tokens;
    this.cards = cards;
    this.oapi = oapi;
  }

  /** 超长文本按 newline 边界切分。 */
  static chunkText(text, limit) {
    const runes = Array.from(text);
    if (!limit || limit <= 0 || runes.length <= limit) return [text];
    const chunks = [];
    let rest = runes;
    while (rest.length > 0) {
      if (rest.length <= limit) {
        chunks.push(rest.join(''));
        break;
      }
      let cut = -1;
      for (let i = limit; i >= Math.floor(limit / 2); i--) {
        if (rest[i] === '\n') {
          cut = i + 1;
          break;
        }
      }
      if (cut <= 0) cut = limit;
      chunks.push(rest.slice(0, cut).join(''));
      rest = rest.slice(cut);
    }
    return chunks;
  }

  /** 出站钩子 + 统一页脚（OutboundConfig）：beforeSend 可改写 payload，footer 追加到文本。 */
  #applyOutbound(msgKey, msgParam) {
    const out = this.cfg.outbound;
    if (!out) return msgParam;
    let param = msgParam;
    if (out.footer) {
      param = { ...msgParam };
      if (msgKey === 'sampleText' && typeof param.content === 'string') {
        param.content = param.content + '\n\n' + out.footer;
      } else if (msgKey === 'sampleMarkdown' && typeof param.text === 'string') {
        param.text = param.text + '\n\n---\n' + out.footer;
      }
    }
    if (out.hooks && out.hooks.beforeSend) {
      const replaced = out.hooks.beforeSend('reply', this.msg.conversationId || '', param);
      if (replaced !== undefined && replaced !== null) param = replaced;
    }
    return param;
  }

  async #webhook(msgKey, msgParam) {
    msgParam = this.#applyOutbound(msgKey, msgParam);
    // 超长 content/text：分片多次发送
    const limit = this.cfg.textChunkLimit || 0;
    if (limit > 0 && msgParam && typeof msgParam === 'object') {
      if (typeof msgParam.content === 'string' && Array.from(msgParam.content).length > limit) {
        for (const c of Reply.chunkText(msgParam.content, limit)) {
          await this.#webhookOnce(msgKey, { content: c });
        }
        return;
      }
      if (typeof msgParam.text === 'string' && Array.from(msgParam.text).length > limit) {
        for (const t of Reply.chunkText(msgParam.text, limit)) {
          await this.#webhookOnce(msgKey, { title: msgParam.title, text: t });
        }
        return;
      }
    }
    return this.#webhookOnce(msgKey, msgParam);
  }

  async #webhookOnce(msgKey, msgParam) {
    if (!this.msg.sessionWebhook) throw new Error('reply: sessionWebhook missing');
    const out = this.cfg.outbound;
    const after = (ok, err) => {
      if (out && out.hooks && out.hooks.afterSend) out.hooks.afterSend('reply', this.msg.conversationId || '', ok, err);
    };
    try {
      const token = await this.tokens.get();
      const resp = await fetch(this.msg.sessionWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        // 官方文档要求 msgParam 为字符串化 JSON（对象形式会 400）。
        body: JSON.stringify({ msgKey, msgParam: JSON.stringify(msgParam) }),
      });
      if (resp.status >= 400) {
        throw new Error(`webhook reply failed: http ${resp.status}`);
      }
      after(true, null);
    } catch (err) {
      after(false, err && err.message);
      throw err;
    }
  }

  text(content) {
    return this.#webhook('sampleText', { content });
  }

  markdown(title, text) {
    return this.#webhook('sampleMarkdown', { title: title || firstLineTitle(text), text });
  }

  image(imageUrl) {
    return this.#webhook('sampleImageMsg', { photoURL: imageUrl });
  }

  /** 换取消息附件下载地址（E9）。 */
  async downloadURL(downloadCode, msgId) {
    const token = await this.tokens.get();
    const url =
      `${this.cfg.apiBase}/v1.0/robot/messageFiles/download` +
      `?downloadCode=${encodeURIComponent(downloadCode)}&messageId=${encodeURIComponent(msgId)}` +
      `&robotCode=${encodeURIComponent(this.cfg.clientId)}`;
    const resp = await fetch(url, { headers: { 'x-acs-dingtalk-access-token': token } });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`downloadURL: http ${resp.status}`);
    return body.downloadUrl || '';
  }

  /** 上传媒体文件，返回 mediaId（E9）。mediaType: image|file|video|voice。 */
  uploadMedia(mediaType, filename, data, contentType) {
    return this.oapi.uploadMedia(mediaType, filename, data, contentType);
  }

  /** 立即创建并投递 AI 卡片（E1）。失败时返回带降级的 streamer（E4）。 */
  async stream() {
    const target = {
      isGroup: this.msg.conversationType === 'group',
      conversationId: this.msg.conversationId,
      userId: this.msg.senderStaffId || this.msg.senderId,
      robotCode: this.cfg.clientId,
    };
    const streamer = new CardStreamer(
      this.cards,
      null,
      (text) => this.text(text),
      this.cfg.streamThrottleMs,
    );
    try {
      streamer.card = await this.cards.createAndDeliver(target);
      streamer.armWatchdogPublic();
    } catch (err) {
      this.cfg.debug('card create failed, fallback to webhook text: %s', err.message);
    }
    return streamer;
  }
}

function firstLineTitle(text) {
  for (const line of String(text || '').split('\n')) {
    const t = line.replace(/^[#*->\s]+/, '');
    if (t) return t.slice(0, 20);
  }
  return 'Message';
}
