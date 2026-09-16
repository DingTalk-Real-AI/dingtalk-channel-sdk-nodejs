// Channel：组装 stream/reply/dedup/policy/lifecycle（SPEC §3/§4）。

import { normalizeConfig } from './config.js';
import { TOPIC_BOT_MESSAGE, TOPIC_CARD_CALLBACK } from './config.js';
import { TokenProvider } from './token.js';
import { Deduper } from './safety/dedup.js';
import { CardClient } from './card.js';
import { normalizeIncoming } from './normalize/message.js';
import { Reply } from './reply.js';
import { StreamConn } from './stream.js';
import { OapiClient } from './media.js';
import { ProactiveSender } from './send.js';
import { Emotion } from './emotion.js';
import { LifecycleHooks } from './lifecycle.js';
import { BotIdentityProvider } from './bot-identity.js';
import { PolicyConfig, PolicyGate, RejectEvent } from './safety/policy.js';
import { ProcessingLock } from './safety/processing-lock.js';
import { MessageBatcher, BatchConfig, BatchedMessage, mergeMessages } from './safety/batching.js';
import { classifyError } from './errors.js';
import { assertPublicUrl } from './safety/ssrf-guard.js';
import { ChatQueueManager, ChatQueueConfig } from './safety/chat-queue.js';
import { verifyHTTPSign } from './http-mode.js';
import { TRANSPORT_HTTP } from './config.js';

/**
 * 用法：
 *   const ch = new DingTalkChannel({ clientId, clientSecret });
 *   ch.on('message', async (msg, reply) => { ... });
 *   await ch.start();
 */
export class DingTalkChannel {
  constructor(config) {
    this.cfg = normalizeConfig(config);
    this.tokens = new TokenProvider(this.cfg);
    this.cards = new CardClient(this.cfg, this.tokens);
    this.oapi = new OapiClient(this.cfg);
    this.sender = new ProactiveSender(this.cfg, this.cards);
    this.emotion = new Emotion(this.cfg, this.cards);
    this.dedup = new Deduper();

    // 新增组件
    this.lifecycle = new LifecycleHooks();
    this.botIdentity = new BotIdentityProvider(this.cfg, this.tokens);
    this.policy = new PolicyGate(this.cfg.policyConfig || new PolicyConfig());
    this.processingLock = new ProcessingLock();

    this.handlers = new Map(); // event -> handler
    this.convLocks = new Map(); // conversationId -> promise chain（同会话串行）
    this.batcher = null;
    // per-chat 串行队列（默认启用；批处理刷新与消息处理共享同会话串行）
    this.chatQueue = new ChatQueueManager(
      null,
      this.cfg.chatQueue || new ChatQueueConfig(),
      this.cfg.mediaBatch
    );
    this.conn = new StreamConn(this.cfg, (frame) => this.#dispatch(frame), this.lifecycle);
  }

  /** @param {'message'|'cardAction'|'batchMessage'|'reject'} event */
  on(event, handler, options) {
    if (event === 'cardAction') this.conn.wantCardTopic = true;
    if (event === 'batchMessage') {
      const batchConfig = options?.batchConfig || new BatchConfig();
      this.batcher = new MessageBatcher(batchConfig, (batched) => this.#invokeBatchHandler(batched));
      this.chatQueue.batchCfg = batchConfig;
    }
    this.handlers.set(event, handler);
    return this;
  }

  async #invokeBatchHandler(batched) {
    const handler = this.handlers.get('batchMessage');
    if (!handler) return;
    const fakeMsg = { conversationId: batched.message.conversationId, sessionWebhook: '' };
    const reply = new Reply(fakeMsg, this.cfg, this.tokens, this.cards, this.oapi);
    await handler(batched, reply);
  }

  /** 阻塞运行（自动重连）。signal 为 AbortSignal。 */
  async start(signal) {
    if (!this.handlers.has('message') && !this.handlers.has('batchMessage')) {
      throw new Error("on('message', handler) or on('batchMessage', handler) must be registered before start()");
    }
    if (this.cfg.transport === TRANSPORT_HTTP) {
      throw new Error(
        'http mode has no long-running connection; call await ch.handleHTTPCallback(body, timestamp, sign) per HTTP request instead of start()'
      );
    }
    this.processingLock.startSweeper();
    try {
      await this.conn.run(signal);
    } finally {
      this.processingLock.dispose();
      this.dedup.dispose();
      if (this.batcher) {
        this.batcher.dispose();
      }
    }
  }

  close() {
    this.conn.close();
    if (this.chatQueue) this.chatQueue.dispose().catch(() => {});
    this.dedup.dispose();
  }

  /** 主动发文本（不依赖入站消息）。target: {userId} 单聊 / {conversationId, atUserIds?, atAll?} 群聊 */
  sendText(target, content) {
    return this.sender.sendText(target, content);
  }

  sendMarkdown(target, title, text) {
    return this.sender.sendMarkdown(target, title, text);
  }

  sendImage(target, imageUrl) {
    return this.sender.sendImage(target, imageUrl);
  }

  sendVideo(target, rawVideoMediaId, rawPicMediaId, durationMs) {
    return this.sender.sendVideo(target, rawVideoMediaId, rawPicMediaId, durationMs);
  }

  sendAudio(target, rawMediaId, durationMs) {
    return this.sender.sendAudio(target, rawMediaId, durationMs);
  }

  /** 下载文件内容（SSRF 防护 downloadFile）。 */
  async downloadFile(url) {
    await assertPublicUrl(url, this.cfg.ssrfAllowlist);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`downloadFile: http ${resp.status}`);
    }
    return resp.arrayBuffer();
  }

  /**
   * 流式下载文件到本地路径，不整块载入内存。
   * SSRF 防护同 downloadFile；父目录必须已存在；先写同目录临时文件再原子
   * 重命名，失败不落半截文件。返回写入的字节数。
   */
  async downloadFileToFile(url, destPath) {
    await assertPublicUrl(url, this.cfg.ssrfAllowlist);
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    const { Readable } = await import('node:stream');

    const dest = path.resolve(destPath);
    const dir = path.dirname(dest);
    await fsp.access(dir); // 父目录必须已存在
    const tmp = path.join(dir, `.${path.basename(dest)}.tmp-${process.pid}-${Date.now()}`);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`downloadFileToFile: http ${resp.status}`);
    }
    try {
      await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmp));
      await fsp.rename(tmp, dest);
      return (await fsp.stat(dest)).size;
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  /** 在用户消息上打"🤔Thinking"状态章（仅人发的消息）。 */
  markThinking(conversationId, msgId) {
    return this.emotion.markThinking(conversationId, msgId);
  }

  /** 把"🤔Thinking"换成"🥳Done"（best-effort）。 */
  markDone(conversationId, msgId) {
    return this.emotion.markDone(conversationId, msgId);
  }

  /** 获取机器人身份信息（带缓存）。 */
  async getBotIdentity() {
    return await this.botIdentity.get();
  }

  /** 更新策略配置。 */
  updatePolicy(config) {
    this.policy.updateConfig(config);
  }

  /** 测试/高级用法：直接注入一帧业务数据（绕过 WebSocket 层）。 */
  async dispatchForTest(frame) {
    return this.#dispatch(frame);
  }

  async #dispatch(frame) {
    const topic = frame?.headers?.topic || '';
    if (topic === TOPIC_BOT_MESSAGE) {
      await this.#handleBotMessage(frame);
    } else if (topic === TOPIC_CARD_CALLBACK) {
      await this.#handleCardAction(frame);
    } else {
      this.cfg.debug('unsubscribed topic %s ignored', topic);
    }
    return '';
  }

  async #handleBotMessage(frame) {
    let msg;
    try {
      msg = normalizeIncoming(frame.data);
    } catch (err) {
      this.cfg.debug('bad bot message payload: %s', err.message);
      return;
    }
    await this.#processIncoming(frame?.headers?.messageId || '', msg);
  }

  /**
   * 处理一帧 HTTP 模式回调（企业内部机器人）。
   * 验签失败/载荷非法抛错（调用方回 401/400）；业务处理与 Stream 模式一致。
   * @param {string|Buffer} body 请求体（与 Stream data 载荷同构）
   * @param {string} timestamp 请求头 timestamp
   * @param {string} sign 请求头 sign
   */
  async handleHTTPCallback(body, timestamp, sign) {
    const messageHandler = this.handlers.get('message');
    if (!messageHandler && !this.batcher) {
      throw new Error("on('message') handler must be registered before handleHTTPCallback()");
    }
    verifyHTTPSign(this.cfg.clientSecret, timestamp, sign, this.cfg.httpTimestampToleranceMs);
    let msg;
    try {
      msg = normalizeIncoming(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
    } catch (err) {
      throw new Error(`http mode: bad bot message payload: ${err.message}`);
    }
    // HTTP 模式回调无协议层投递 ID，两层去重均落 msgId。
    await this.#processIncoming(msg.msgId, msg);
  }

  /** 传输无关的处理管线：去重 → 过期过滤 → 策略 → 处理锁 → 批处理/处理器。 */
  async #processIncoming(protocolMessageId, msg) {
    if (this.dedup.checkAndMark(protocolMessageId, msg.msgId)) {
      this.cfg.debug('duplicate message dropped: msgId=%s', msg.msgId);
      return; // E6
    }
    // 过期消息过滤
    const windowMs = this.cfg.staleMessageWindowMs || 0;
    if (windowMs > 0 && msg.createAt > 0 && Date.now() - msg.createAt > windowMs) {
      this.cfg.debug('stale message dropped: msgId=%s', msg.msgId);
      return;
    }

    // 策略门控
    const decision = this.policy.evaluate(msg);
    if (!decision.allowed) {
      this.cfg.debug('message rejected by policy: msgId=%s, reason=%s', msg.msgId, decision.reason);
      const rejectHandler = this.handlers.get('reject');
      if (rejectHandler) {
        const event = new RejectEvent({
          messageId: msg.msgId,
          chatId: msg.conversationId,
          senderId: msg.senderId,
          reason: decision.reason,
        });
        try {
          await rejectHandler(event);
        } catch (err) {
          this.cfg.debug('reject handler error: %s', err.message);
        }
      }
      return;
    }

    // 处理锁（防止并发处理同一消息）
    const lockId = msg.msgId || protocolMessageId;
    if (!this.processingLock.acquire(lockId)) {
      this.cfg.debug('message already processing: msgId=%s', msg.msgId);
      return;
    }

    try {
      // ChatQueue 启用：批处理刷新与消息处理共享 per-chat 串行
      if (this.chatQueue.queueCfg.enabled) {
        if (this.batcher) {
          this.chatQueue.push(msg.conversationId, msg, async (batch) => {
            const merged = mergeMessages(batch);
            const sourceIds = batch.map((m) => m.msgId);
            await this.#invokeBatchHandler(new BatchedMessage({ message: merged, sourceIds }));
          });
          return;
        }
        await this.chatQueue.run(msg.conversationId, async () => {
          const reply = new Reply(msg, this.cfg, this.tokens, this.cards, this.oapi);
          try {
            await this.handlers.get('message')(msg, reply);
          } catch (err) {
            const classified = classifyError(err);
            this.cfg.debug('message handler error: %s', classified);
          }
        });
        return;
      }

      // ChatQueue 关闭：回退旧行为
      if (this.batcher) {
        this.batcher.push(msg);
        return;
      }

      // 普通模式：同会话串行（E5）
      await this.#serialize(msg.conversationId, async () => {
        const reply = new Reply(msg, this.cfg, this.tokens, this.cards, this.oapi);
        try {
          await this.handlers.get('message')(msg, reply);
        } catch (err) {
          const classified = classifyError(err);
          this.cfg.debug('message handler error: %s', classified);
        }
      });
    } finally {
      this.processingLock.release(lockId);
    }
  }

  async #handleCardAction(frame) {
    const handler = this.handlers.get('cardAction');
    if (!handler) return;
    let d = {};
    try {
      d = JSON.parse(frame.data);
    } catch {
      return;
    }
    const action = {
      outTrackId: d.outTrackId || '',
      userId: d.userId || '',
      dataContent: d.dataContent ?? null,
      raw: d,
    };
    const invoke = async () => {
      const fakeMsg = { conversationId: action.outTrackId, sessionWebhook: '' };
      try {
        await handler(action, new Reply(fakeMsg, this.cfg, this.tokens, this.cards, this.oapi));
      } catch (err) {
        const classified = classifyError(err);
        this.cfg.debug('card action handler error: %s', classified);
      }
    };
    // 卡片回调与同会话消息共享串行队列
    if (this.chatQueue.queueCfg.enabled) {
      await this.chatQueue.run(action.outTrackId, invoke);
    } else {
      await invoke();
    }
  }

  #serialize(conversationId, task) {
    const prev = this.convLocks.get(conversationId) || Promise.resolve();
    const next = prev.then(task, task);
    this.convLocks.set(conversationId, next.catch(() => {}));
    return next;
  }
}
