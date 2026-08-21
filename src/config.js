/** 配置与常量（SPEC §8/§10）。 */

export const DEFAULT_API_BASE = 'https://api.dingtalk.com';
export const DEFAULT_OAPI_BASE = 'https://oapi.dingtalk.com';
export const DEFAULT_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';
export const DEFAULT_STREAM_THROTTLE_MS = 800;
export const DEFAULT_CARD_WATCHDOG_MS = 10 * 60 * 1000; // 孤儿卡强制收口
export const DEFAULT_ERROR_COOLDOWN_MS = 60 * 1000; // 错误兜底文本冷却
export const DEFAULT_STALE_WINDOW_MS = 30 * 60 * 1000; // 过期消息过滤
export const DEFAULT_TEXT_CHUNK_LIMIT = 3500; // 超长文本分片
export const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CARD_QPS = 20;
export const QPS_BACKOFF_MS = 2000;
export const KEEPALIVE_IDLE_MS = 120_000;
export const PONG_WAIT_MS = 5_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const TOPIC_BOT_MESSAGE = '/v1.0/im/bot/messages/get';
export const TOPIC_CARD_CALLBACK = '/v1.0/card/instances/callback';
export const USER_AGENT = 'dingtalk-channel-sdk-nodejs/v0.1.0';

// 传输模式。对齐钉钉官方两种接收消息模式：stream 为默认长连接；http 为 HTTP 模式（dispatcher 形态：
// 验签与分发由 SDK 负责，HTTP 服务由外部提供，见 http-mode.js）。
export const TRANSPORT_STREAM = 'stream';
export const TRANSPORT_HTTP = 'http';
export const DEFAULT_HTTP_TIMESTAMP_TOLERANCE_MS = 60 * 60 * 1000;

/** 出站重试参数（指数退避）。 */
export class RetryConfig {
  /** @param {{maxAttempts?: number, baseDelayMs?: number}} [opts] */
  constructor({ maxAttempts = 3, baseDelayMs = 500 } = {}) {
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
  }
}

/** 出站钩子：before_send(kind, target, payload) 可返回替换 payload；after_send(kind, target, ok, error)。 */
export class OutboundHooks {
  /** @param {{beforeSend?: Function, afterSend?: Function}} [opts] */
  constructor({ beforeSend = null, afterSend = null } = {}) {
    this.beforeSend = beforeSend;
    this.afterSend = afterSend;
  }
}

/** 出站配置：重试参数、钩子、统一页脚。 */
export class OutboundConfig {
  /** @param {{retry?: RetryConfig, hooks?: OutboundHooks, footer?: string}} [opts] */
  constructor({ retry = new RetryConfig(), hooks = new OutboundHooks(), footer = '' } = {}) {
    this.retry = retry;
    this.hooks = hooks;
    this.footer = footer;
  }
}

/**
 * @param {{
 *   clientId: string, clientSecret: string, apiBase?: string,
 *   cardTemplateId?: string, streamThrottleMs?: number, cardQps?: number,
 *   autoReconnect?: boolean, keepAliveIdleMs?: number, debug?: (fmt: string, ...args: any[]) => void,
 *   policyConfig?: object, transport?: 'stream' | 'http',
 *   chatQueue?: object, mediaBatch?: object, outbound?: object, ssrfAllowlist?: string[]
 * }} config
 */
export function normalizeConfig(config) {
  if (!config?.clientId || !config?.clientSecret) {
    throw new Error('Config.clientId and Config.clientSecret are required');
  }
  const transport = config.transport || TRANSPORT_STREAM;
  if (transport !== TRANSPORT_STREAM && transport !== TRANSPORT_HTTP) {
    throw new Error(`Config.transport: unknown transport '${transport}' (supported: stream, http)`);
  }
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    apiBase: config.apiBase || DEFAULT_API_BASE,
    oapiBase: config.oapiBase || DEFAULT_OAPI_BASE,
    cardTemplateId: config.cardTemplateId || DEFAULT_CARD_TEMPLATE_ID,
    streamThrottleMs: config.streamThrottleMs ?? DEFAULT_STREAM_THROTTLE_MS,
    cardWatchdogMs: config.cardWatchdogMs ?? DEFAULT_CARD_WATCHDOG_MS,
    errorCooldownMs: config.errorCooldownMs ?? DEFAULT_ERROR_COOLDOWN_MS,
    staleMessageWindowMs: config.staleMessageWindowMs ?? DEFAULT_STALE_WINDOW_MS,
    textChunkLimit: config.textChunkLimit ?? DEFAULT_TEXT_CHUNK_LIMIT,
    cardQps: config.cardQps ?? DEFAULT_CARD_QPS,
    autoReconnect: config.autoReconnect ?? true,
    keepAliveIdleMs: config.keepAliveIdleMs ?? KEEPALIVE_IDLE_MS,
    policyConfig: config.policyConfig || null,
    transport,
    httpTimestampToleranceMs: config.httpTimestampToleranceMs ?? DEFAULT_HTTP_TIMESTAMP_TOLERANCE_MS,
    chatQueue: config.chatQueue || null,
    mediaBatch: config.mediaBatch || null,
    outbound: config.outbound || null,
    ssrfAllowlist: config.ssrfAllowlist || [],
    debug: config.debug || (() => {}),
  };
}
