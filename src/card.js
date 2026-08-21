// AI 卡片五步协议客户端（SPEC §5）+ 全局限流（SPEC §6）。

import { normalizeForCard } from './outbound/markdown.js';
import { TokenBucket } from './ratelimit.js';

export const FLOW_PROCESSING = '1';
export const FLOW_INPUTING = '2';
export const FLOW_FINISHED = '3';
export const FLOW_FAILED = '5';

function randSuffix(n) {
  let s = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(`dingtalk api error: http=${status} code=${code} ${message || ''}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
  get isQpsLimit() {
    return this.status === 403 && typeof this.code === 'string' && this.code.includes('QpsLimit');
  }
}

export class CardClient {
  constructor(cfg, tokens) {
    this.cfg = cfg;
    this.tokens = tokens;
    this.bucket = new TokenBucket(cfg.cardQps);
  }

  async #call(method, path, body) {
    await this.#callRaw(method, path, body);
  }

  async #callRaw(method, path, body) {
    const doCall = async () => {
      const token = await this.tokens.get();
      const resp = await fetch(`${this.cfg.apiBase}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await resp.text();
      if (resp.status >= 400) {
        let err = {};
        try {
          err = JSON.parse(text);
        } catch {}
        throw new ApiError(resp.status, err.code, err.message, err);
      }
      return text;
    };
    await this.bucket.waitFor();
    try {
      return await doCall();
    } catch (err) {
      if (err instanceof ApiError && err.isQpsLimit) {
        this.bucket.triggerBackoff();
        await this.bucket.waitFor();
        return doCall();
      }
      throw err;
    }
  }

  /** 公开底层调用（主动发消息等复用 token/限流/重试）。 */
  async callPublic(method, path, body) {
    return this.#call(method, path, body);
  }

  /**
   * 业务级校验（dws 生产实证）：卡片 API 会在 HTTP 200 里返回
   * {"result":[{"success":false,...}]}，必须视为失败。
   */
  async #callChecked(method, path, body) {
    const raw = await this.#callRaw(method, path, body);
    if (raw && raw.includes('"success":false')) {
      throw new ApiError(200, 'BusinessFailure', 'business failure inside http 200', raw);
    }
  }

  async createAndDeliver(target) {
    const outTrackId = `card_${Date.now()}_${randSuffix(8)}`;
    await this.#call('POST', '/v1.0/card/instances', {
      cardTemplateId: this.cfg.cardTemplateId,
      outTrackId,
      cardData: { cardParamMap: { config: '{"autoLayout":true}' } },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    });

    const deliverBody = target.isGroup
      ? {
          outTrackId,
          userIdType: 1,
          openSpaceId: `dtv1.card//IM_GROUP.${target.conversationId}`,
          imGroupOpenDeliverModel: { robotCode: target.robotCode },
        }
      : {
          outTrackId,
          userIdType: 1,
          openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
          imRobotOpenDeliverModel: {
            spaceType: 'IM_ROBOT',
            robotCode: target.robotCode,
            extension: { dynamicSummary: 'true' },
          },
        };
    await this.#callChecked('POST', '/v1.0/card/instances/deliver', deliverBody);
    return { outTrackId, inputingStarted: false };
  }

  async setStatus(card, status, content) {
    const body = {
      outTrackId: card.outTrackId,
      cardData: {
        cardParamMap: {
          flowStatus: status,
          msgContent: content,
          staticMsgContent: '',
          sys_full_json_obj: '{"order":["msgContent"]}',
          config: '{"autoLayout":true}',
        },
      },
    };
    if (status === FLOW_FINISHED) {
      body.cardUpdateOptions = { updateCardDataByKey: true };
    }
    await this.#call('PUT', '/v1.0/card/instances', body);
  }

  async stream(card, content, finalize) {
    let norm = normalizeForCard(content);
    if (!finalize) norm = norm.replace(/\n+$/, '');
    await this.#call('PUT', '/v1.0/card/streaming', {
      outTrackId: card.outTrackId,
      guid: `${Date.now()}_${randSuffix(6)}`,
      key: 'msgContent',
      content: norm,
      isFull: true,
      isFinalize: finalize,
      isError: false,
    });
  }
}

/** 流式卡片句柄：append 节流、finish 收口、fail 置错（E1–E4）。 */
export class CardStreamer {
  constructor(client, card, fallback, throttleMs, cfg) {
    this.client = client;
    this.card = card;
    this.fallback = fallback; // async (text) => void，卡片失败时的降级通道
    this.throttle = throttleMs;
    this.accumulated = '';
    this.lastUpdate = 0;
    this.closed = false;
    this.pendingTimer = null;
    this.frameCount = 0;
    this.lastFrameAt = 0;
    this.watchdogTimer = null;
    this.aborted = false;
  }

  // flush-controller 效果参数
  static LONG_GAP_THRESHOLD_MS = 2000;
  static LONG_GAP_BATCH_MS = 300;
  // dws 实证：帧间隔防"内容加载失败"竞态；单帧内容上限
  static FRAME_GAP_MS = 500;
  static MAX_CONTENT = 20000;

  /** 公开：启动看门狗（reply.stream 内部调用）。 */
  armWatchdogPublic() {
    this.#armWatchdog();
  }

  /** 卡片是否真实创建并投递成功（诊断用；false 表示处于降级模式）。 */
  get cardDelivered() {
    return this.card != null;
  }

  async append(delta) {
    if (this.closed) throw new Error('streamer already closed');
    this.accumulated += delta;
    if (!this.card) return; // 卡片不可用（E4 降级模式）：仅累积，finish 时走降级
    const now = Date.now();
    const elapsed = now - this.lastUpdate;
    if (elapsed >= this.throttle && elapsed > CardStreamer.LONG_GAP_THRESHOLD_MS) {
      // 长间隔（工具调用/思考）后：延迟攒批
      this.#schedulePending(CardStreamer.LONG_GAP_BATCH_MS);
    } else if (elapsed >= this.throttle) {
      this.lastUpdate = now;
      await this.#update(this.accumulated, false);
    } else if (!this.pendingTimer) {
      // 窗口内不丢弃：trailing flush，内容最终必达
      this.#schedulePending(this.throttle - elapsed);
    }
  }

  #schedulePending(delayMs) {
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      if (this.closed || !this.card) return;
      this.lastUpdate = Date.now();
      this.#update(this.accumulated, false).catch(() => {});
    }, Math.max(1, delayMs));
  }

  async #update(content, finalize) {
    if (!this.card) throw new Error('card unavailable');
    // 首帧与投递间、终帧与上帧间留出间隔（防"内容加载失败"竞态，dws 实证）
    if (this.frameCount === 0 || finalize) {
      const elapsed = Date.now() - this.lastFrameAt;
      if (elapsed < CardStreamer.FRAME_GAP_MS) {
        await new Promise((r) => setTimeout(r, CardStreamer.FRAME_GAP_MS - elapsed));
      }
    }
    const runes = Array.from(content);
    if (runes.length > CardStreamer.MAX_CONTENT) content = runes.slice(0, CardStreamer.MAX_CONTENT).join('');
    if (!this.card.inputingStarted) {
      await this.client.setStatus(this.card, FLOW_INPUTING, normalizeForCard(content));
      this.card.inputingStarted = true;
    }
    this.frameCount += 1;
    this.lastFrameAt = Date.now();
    this.#resetWatchdog();
    await this.client.stream(this.card, content, finalize);
  }

  // 孤儿卡看门狗：超时未收口强制 finish（connector 同款防线）
  #armWatchdog() {
    this.#resetWatchdog();
  }

  #resetWatchdog() {
    if (!this.cfg || this.cfg.cardWatchdogMs <= 0 || !this.card) return;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.closed || !this.card) return;
      this.closed = true; // 密封
      const content = this.accumulated;
      this.client.stream(this.card, content, true).catch(() => {});
      this.client
        .setStatus(this.card, FLOW_FINISHED, normalizeForCard(content))
        .catch(() => {});
    }, this.cfg.cardWatchdogMs);
  }

  #clearWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** 显式中止：密封流，卡片置 FAILED；幂等。 */
  async abort() {
    if (this.closed) return;
    this.closed = true;
    this.aborted = true;
    this.#clearWatchdog();
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.card) return;
    try {
      await this.client.stream(this.card, this.accumulated, true);
      await this.client.setStatus(this.card, FLOW_FAILED, normalizeForCard(this.accumulated));
    } catch {}
  }

  async finish(text = '') {
    if (this.closed) return;
    this.closed = true;
    this.#clearWatchdog();
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (text) this.accumulated = text;
    const content = this.accumulated;
    if (!this.card) return this.#fallback(content);
    try {
      await this.#update(content, true);
      await this.client.setStatus(this.card, FLOW_FINISHED, normalizeForCard(content));
    } catch (err) {
      await this.#fallback(content); // E4：降级保证用户拿到回复
      throw err;
    }
  }

  async fail(errText) {
    if (this.closed) return;
    this.closed = true;
    this.#clearWatchdog();
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.card) {
      try {
        if (!this.card.inputingStarted) {
          await this.client.setStatus(this.card, FLOW_INPUTING, '');
          this.card.inputingStarted = true;
        }
        await this.client.stream(this.card, errText, true);
        await this.client.setStatus(this.card, FLOW_FAILED, normalizeForCard(errText));
      } catch {}
    }
    await this.#fallback(errText);
  }

  async #fallback(text) {
    if (!this.fallback || !text.trim()) return;
    try {
      await this.fallback(text);
    } catch {}
  }
}
