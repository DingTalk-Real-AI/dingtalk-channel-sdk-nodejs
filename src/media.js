// 媒体上传：OAPI gettoken + multipart /media/upload（对比官方 connector media/common.ts 移植，E9）。

import { DEFAULT_OAPI_BASE } from './config.js';

export class OapiClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.token = '';
    this.expiresAt = 0;
  }

  async #getToken() {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const url =
      `${this.cfg.oapiBase}/gettoken?appkey=${encodeURIComponent(this.cfg.clientId)}` +
      `&appsecret=${encodeURIComponent(this.cfg.clientSecret)}`;
    const resp = await fetch(url);
    const body = await resp.json().catch(() => ({}));
    if (body.errcode !== 0 || !body.access_token) {
      throw new Error(`oapi gettoken: errcode=${body.errcode} ${body.errmsg || ''}`);
    }
    this.token = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in || 7200) * 1000;
    return this.token;
  }

  /**
   * 上传媒体文件，返回 mediaId（去前导 @）。
   * @param {'image'|'file'|'video'|'voice'} mediaType
   * @param {string} filename
   * @param {Blob|Uint8Array|Buffer|string} data
   * @param {string} [contentType] 空则按类型推断
   * @returns {Promise<{mediaId: string, type?: string, createdAt?: string}>}
   */
  async uploadMedia(mediaType, filename, data, contentType = '') {
    const token = await this.#getToken();
    if (!contentType) {
      contentType = mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream';
    }
    const form = new FormData();
    form.append('media', new Blob([data], { type: contentType }), filename);
    const url =
      `${this.cfg.oapiBase}/media/upload?access_token=${encodeURIComponent(token)}` +
      `&type=${encodeURIComponent(mediaType)}`;
    const resp = await fetch(url, { method: 'POST', body: form });
    const body = await resp.json().catch(() => ({}));
    if (body.errcode !== 0 && body.errcode !== undefined) {
      throw new Error(`media/upload: errcode=${body.errcode} ${body.errmsg || ''}`);
    }
    if (!body.media_id) throw new Error(`media/upload: no media_id in response`);
    const mediaId = body.media_id.startsWith('@') ? body.media_id.substring(1) : body.media_id;
    return {
      mediaId,
      type: body.type,
      createdAt: body.created_at,
      // AI 卡片内嵌必须用完整 URL（openclaw connector 新版 media.ts 实证），裸 mediaId 不渲染
      downloadUrl: `https://down.dingtalk.com/media/${mediaId}`,
    };
  }
}

export { DEFAULT_OAPI_BASE };
