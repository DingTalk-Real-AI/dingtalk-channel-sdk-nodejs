/**
 * 消息批处理。
 */

/**
 * 配置消息批处理行为
 */
export class BatchConfig {
  /**
   * @param {Object} params
   * @param {number} params.delayMs - 批处理延迟（毫秒），默认 600ms
   * @param {number} params.longThresholdChars - 长消息阈值（字符数）
   * @param {number} params.longDelayMs - 长消息延迟（毫秒），默认 2s
   * @param {number} params.maxMessages - 最大批处理消息数，默认 8
   * @param {number} params.maxChars - 最大批处理字符数，默认 4000
   */
  constructor({
    delayMs = 600,
    longThresholdChars = 1000,
    longDelayMs = 2000,
    maxMessages = 8,
    maxChars = 4000,
  } = {}) {
    this.delayMs = delayMs;
    this.longThresholdChars = longThresholdChars;
    this.longDelayMs = longDelayMs;
    this.maxMessages = maxMessages;
    this.maxChars = maxChars;
  }
}

/**
 * 批处理后的消息
 */
export class BatchedMessage {
  /**
   * @param {Object} params
   * @param {IncomingMessage} params.message - 合并后的消息
   * @param {string[]} params.sourceIds - 源消息 ID 列表
   */
  constructor({ message, sourceIds = [] }) {
    this.message = message;
    this.sourceIds = sourceIds;
  }
}

/**
 * 单个会话的批处理管道
 * @private
 */
class ChatPipeline {
  /**
   * @param {BatchConfig} cfg
   * @param {string} scope
   * @param {Function} handler
   */
  constructor(cfg, scope, handler) {
    this.cfg = cfg;
    this.scope = scope;
    this.handler = handler;
    this._buffer = [];
    this._bufferChars = 0;
    this._timer = null;
  }

  /**
   * 添加消息到管道
   * @param {IncomingMessage} msg
   */
  push(msg) {
    this._buffer.push(msg);
    this._bufferChars += (msg.text || '').length;

    // 检查是否达到阈值
    if (this._buffer.length >= this.cfg.maxMessages || this._bufferChars >= this.cfg.maxChars) {
      this._clearTimer();
      setImmediate(() => this._flush());
      return;
    }

    // 设置延迟刷新
    this._clearTimer();
    let delay = this.cfg.delayMs;
    if (this._bufferChars >= this.cfg.longThresholdChars) {
      delay = this.cfg.longDelayMs;
    }

    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, delay);
  }

  /**
   * 立即刷新
   */
  flushNow() {
    if (this._buffer.length > 0) {
      this._clearTimer();
      setImmediate(() => this._flush());
    }
  }

  /**
   * @private
   */
  async _flush() {
    if (this._buffer.length === 0) {
      return;
    }

    const batch = this._buffer;
    this._buffer = [];
    this._bufferChars = 0;

    // 合并消息
    const merged = mergeMessages(batch);
    const sourceIds = batch.map(m => m.msgId);

    const batched = new BatchedMessage({ message: merged, sourceIds });

    if (this.handler) {
      try {
        await this.handler(batched);
      } catch (err) {
        // ignore
      }
    }
  }

  /**
   * @private
   */
  _clearTimer() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * 清理管道
   */
  dispose() {
    this._clearTimer();
    this._buffer = [];
  }
}

/**
 * 消息批处理器（按会话分组）
 */
export class MessageBatcher {
  /**
   * @param {BatchConfig} cfg
   * @param {Function} handler
   */
  constructor(cfg, handler) {
    this.cfg = cfg;
    this.handler = handler;
    this._pipelines = new Map();
  }

  /**
   * 添加消息到批处理队列
   * @param {IncomingMessage} msg
   */
  push(msg) {
    const scope = msg.conversationId || msg.msgId;
    const pipeline = this._getOrCreate(scope);
    pipeline.push(msg);
  }

  /**
   * @private
   */
  _getOrCreate(scope) {
    if (this._pipelines.has(scope)) {
      return this._pipelines.get(scope);
    }
    const p = new ChatPipeline(this.cfg, scope, this.handler);
    this._pipelines.set(scope, p);
    return p;
  }

  /**
   * 立即刷新所有批处理
   */
  flushAll() {
    for (const p of this._pipelines.values()) {
      p.flushNow();
    }
  }

  /**
   * 清理所有批处理
   */
  dispose() {
    this.flushAll();
    for (const p of this._pipelines.values()) {
      p.dispose();
    }
    this._pipelines.clear();
  }
}

/**
 * 合并多条消息为一条
 * @param {IncomingMessage[]} msgs
 * @returns {IncomingMessage}
 */
export function mergeMessages(msgs) {
  if (msgs.length === 0) {
    throw new Error('cannot merge empty message list');
  }
  if (msgs.length === 1) {
    return msgs[0];
  }

  // 以最后一条为基础
  const last = msgs[msgs.length - 1];
  const merged = { ...last };

  // 合并文本内容
  const texts = msgs.map(m => m.text || '').filter(t => t);
  if (texts.length > 0) {
    merged.text = texts.join('\n\n');
  }

  // 合并资源（媒体批处理：downloadCode 去重，保持到达顺序）
  const resources = [];
  const seenCodes = new Set();
  for (const m of msgs) {
    for (const r of m.resources || []) {
      const key = (r && r.downloadCode) || JSON.stringify(r);
      if (key && !seenCodes.has(key)) {
        seenCodes.add(key);
        resources.push(r);
      }
    }
  }
  if (resources.length) merged.resources = resources;

  // 合并 @提及（按用户去重）
  const mentions = [];
  const seenMentions = new Set();
  for (const m of msgs) {
    for (const mn of m.mentions || []) {
      const key = (mn && (mn.userId || mn.name)) || String(mn);
      if (!seenMentions.has(key)) {
        seenMentions.add(key);
        mentions.push(mn);
      }
    }
  }
  if (mentions.length) merged.mentions = mentions;

  return merged;
}
