// Stream 长连接：open → wss → 心跳 → 重连 → ACK（SPEC §2 / E8）。

import os from 'node:os';
import WebSocket from 'ws';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, TOPIC_BOT_MESSAGE, TOPIC_CARD_CALLBACK, USER_AGENT } from './config.js';
import { SUB_CALLBACK, SUB_SYSTEM, successAck } from './frame.js';

function firstLanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '';
}

function backoffDelay(attempt) {
  const d = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return d + Math.random() * 1000;
}

export class StreamConn {
  /**
   * @param cfg normalized config
   * @param {(frame: any) => Promise<string>|string} onFrame 返回 ACK data（空串用默认）
   * @param {LifecycleHooks} [lifecycle] 生命周期钩子
   */
  constructor(cfg, onFrame, lifecycle) {
    this.cfg = cfg;
    this.onFrame = onFrame;
    this.lifecycle = lifecycle;
    this.ws = null;
    this.stopped = false;
    this.wantCardTopic = false;
    this.lastPongAt = 0;
    this.idleTimer = null;
    this.pongTimer = null;
  }

  /** 构建订阅列表（公开以便测试验证 E7 订阅自动添加）。 */
  buildSubscriptions() {
    const subs = [
      { type: SUB_SYSTEM, topic: 'ping' },
      { type: SUB_SYSTEM, topic: 'disconnect' },
      { type: SUB_CALLBACK, topic: TOPIC_BOT_MESSAGE },
    ];
    if (this.wantCardTopic) {
      subs.push({ type: SUB_CALLBACK, topic: TOPIC_CARD_CALLBACK });
    }
    return subs;
  }

  async #open() {
    const subs = this.buildSubscriptions();
    const resp = await fetch(`${this.cfg.apiBase}/v1.0/gateway/connections/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        clientId: this.cfg.clientId,
        clientSecret: this.cfg.clientSecret,
        subscriptions: subs,
        ua: USER_AGENT,
        localIp: firstLanIP(),
      }),
    });
    if (!resp.ok) throw new Error(`gateway open: http ${resp.status}`);
    const { endpoint, ticket } = await resp.json();
    if (!endpoint || !ticket) throw new Error('gateway open: empty endpoint/ticket');
    return { endpoint, ticket };
  }

  /** 阻塞运行；断开按配置重连。signal 为 AbortSignal。 */
  async run(signal) {
    let attempt = 0;
    for (;;) {
      const err = await this.#runOnce(signal);
      if (this.stopped) return;
      if (signal?.aborted) return;
      if (!this.cfg.autoReconnect) {
        if (this.lifecycle) {
          this.lifecycle.fireError(err);
        }
        throw err;
      }
      const delay = backoffDelay(attempt++);
      this.cfg.debug('stream disconnected (%s), reconnect in %dms', err?.message, delay);
      if (this.lifecycle) {
        this.lifecycle.fireReconnecting();
      }
      await new Promise((r) => setTimeout(r, delay));
      if (this.lifecycle) {
        this.lifecycle.fireReconnected();
      }
    }
  }

  async #runOnce(signal) {
    try {
      const { endpoint, ticket } = await this.#open();
      const ws = new WebSocket(`${endpoint}?ticket=${encodeURIComponent(ticket)}`);
      this.ws = ws;
      return await new Promise((resolve) => {
        const clearTimers = () => {
          if (this.idleTimer) clearTimeout(this.idleTimer);
          if (this.pongTimer) clearTimeout(this.pongTimer);
        };
        const resetIdle = () => {
          if (this.idleTimer) clearTimeout(this.idleTimer);
          this.idleTimer = setTimeout(() => {
            try {
              this.lastPongAt = 0;
              ws.ping();
              if (this.pongTimer) clearTimeout(this.pongTimer);
              this.pongTimer = setTimeout(() => {
                if (this.lastPongAt === 0) ws.terminate(); // pong 超时 → close → 重连
              }, 5_000);
            } catch {
              ws.terminate();
            }
          }, this.cfg.keepAliveIdleMs);
        };

        ws.on('pong', () => {
          this.lastPongAt = Date.now();
        });
        ws.on('open', () => {
          this.cfg.debug('stream connected');
          if (this.lifecycle) {
            this.lifecycle.fireReady();
          }
          resetIdle();
        });
        ws.on('message', async (raw) => {
          resetIdle();
          try {
            const frame = JSON.parse(raw.toString());
            await this.#handleFrame(ws, frame);
          } catch (err) {
            this.cfg.debug('bad frame: %s', err.message);
          }
        });
        ws.on('close', () => {
          clearTimers();
          if (this.lifecycle) {
            this.lifecycle.fireDisconnected();
          }
          resolve(new Error('connection closed'));
        });
        ws.on('error', (err) => {
          clearTimers();
          if (this.lifecycle) {
            this.lifecycle.fireError(err);
          }
          resolve(err);
        });
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              this.stopped = true;
              ws.close();
            },
            { once: true },
          );
        }
      });
    } catch (err) {
      if (this.lifecycle) {
        this.lifecycle.fireError(err);
      }
      return err;
    } finally {
      this.ws = null;
    }
  }

  async #handleFrame(ws, frame) {
    const topic = frame?.headers?.topic || '';
    const messageId = frame?.headers?.messageId || '';

    if (frame.type === SUB_SYSTEM && topic === 'ping') {
      const ack = successAck(messageId);
      ack.data = frame.data ?? '';
      ws.send(JSON.stringify(ack));
      return;
    }
    if (frame.type === SUB_SYSTEM && topic === 'disconnect') {
      ws.send(JSON.stringify(successAck(messageId)));
      this.ws?.close(); // close → runOnce resolve → 重连
      return;
    }

    // ACK 先行（对齐官方 connector）：立即确认，业务处理异步进行，
    // 防止长任务期间服务端超时重投。重复投递由双层去重兜底（E6）。
    ws.send(JSON.stringify(successAck(messageId)));
    if (this.onFrame) {
      await Promise.resolve(this.onFrame(frame)).catch(() => {}); // 异步语义：不阻塞 ACK
    }
  }

  close() {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.ws?.close();
  }
}
