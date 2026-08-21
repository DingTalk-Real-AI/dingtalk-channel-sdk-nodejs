/**
 * per-chat 串行队列：同会话消息强制串行处理，批处理刷新同样按会话串行。
 */
import { BatchConfig } from './batching.js';

/**
 * per-chat 串行队列配置。
 */
export class ChatQueueConfig {
  /** @param {{enabled?: boolean}} [opts] */
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
  }
}

/**
 * 媒体消息批处理（默认关闭）。
 * 启用后同会话连续媒体在 delayMs 窗口内合并投递，资源列表合并。
 */
export class MediaBatchConfig {
  /** @param {{enabled?: boolean, delayMs?: number, maxItems?: number}} [opts] */
  constructor({ enabled = false, delayMs = 800, maxItems = 9 } = {}) {
    this.enabled = enabled;
    this.delayMs = delayMs;
    this.maxItems = maxItems;
  }
}

/** 单 scope（conversationId）的串行队列 + 批处理缓冲。 */
export class ChatQueue {
  /**
   * @param {string} scope
   * @param {import('./batching.js').BatchConfig} batchCfg
   * @param {MediaBatchConfig|null} mediaBatch
   */
  constructor(scope, batchCfg, mediaBatch = null) {
    this.scope = scope;
    this.batchCfg = batchCfg;
    this.mediaBatch = mediaBatch;
    this._buffer = [];
    this._bufferChars = 0;
    this._timer = null;
    this._pending = null;
    this._tail = Promise.resolve(); // 串行链
  }

  /** 串行执行任务（同会话一次一个）。 @returns {Promise<any>} */
  run(task) {
    const next = this._tail.then(task, task);
    this._tail = next.catch(() => {});
    return next;
  }

  /** 缓冲 + debounce；flush 串接在串行链上。 */
  push(msg, handler) {
    this._buffer.push(msg);
    this._bufferChars += (msg.text || '').length;
    if (!this._pending) this._pending = handler;

    const mediaEnabled = this.mediaBatch && this.mediaBatch.enabled;
    const maxItems = this.mediaBatch ? this.mediaBatch.maxItems : 8;

    if (this._buffer.length >= Math.min(this.batchCfg.maxMessages, maxItems) || this._bufferChars >= this.batchCfg.maxChars) {
      this.#clearTimer();
      this.#enqueueFlush();
      return;
    }
    if (this.batchCfg.delayMs <= 0) {
      this.#clearTimer();
      this.#enqueueFlush();
      return;
    }
    this.#clearTimer();
    let delay = this.batchCfg.delayMs;
    if (this._bufferChars >= this.batchCfg.longThresholdChars) delay = this.batchCfg.longDelayMs;
    if (mediaEnabled && msg.resources && msg.resources.length) delay = this.mediaBatch.delayMs;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._buffer.length) this.#enqueueFlush();
    }, delay);
  }

  #clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  #enqueueFlush() {
    if (!this._buffer.length) return;
    const batch = this._buffer;
    const handler = this._pending;
    this._buffer = [];
    this._bufferChars = 0;
    this._pending = null;
    if (!handler) return;
    // flush 串接在串行链上：与 run() 共享同会话串行
    this.run(async () => handler(batch));
  }

  async flushNow() {
    this.#clearTimer();
    this.#enqueueFlush();
    await this._tail;
  }

  async dispose() {
    this.#clearTimer();
    this.#enqueueFlush();
    await this._tail;
  }
}

/** scope → ChatQueue 的惰性注册表。 */
export class ChatQueueManager {
  /**
   * @param {import('./batching.js').BatchConfig} batchCfg
   * @param {ChatQueueConfig|null} queueCfg
   * @param {MediaBatchConfig|null} mediaBatch
   */
  constructor(batchCfg, queueCfg = null, mediaBatch = null) {
    this.batchCfg = batchCfg || new BatchConfig();
    this.queueCfg = queueCfg || new ChatQueueConfig();
    this.mediaBatch = mediaBatch;
    this._queues = new Map();
  }

  _get(scope) {
    let q = this._queues.get(scope);
    if (!q) {
      q = new ChatQueue(scope, this.batchCfg, this.mediaBatch);
      this._queues.set(scope, q);
    }
    return q;
  }

  run(scope, task) {
    return this._get(scope).run(task);
  }

  push(scope, msg, handler) {
    this._get(scope).push(msg, handler);
  }

  async flushAll() {
    await Promise.all([...this._queues.values()].map(q => q.flushNow()));
  }

  async dispose() {
    await Promise.all([...this._queues.values()].map(q => q.dispose()));
    this._queues.clear();
  }
}
