/**
 * HTTP 模式传输（dispatcher 形态）：验签与消息分发由 SDK 负责，HTTP 服务由外部提供。
 *
 * 钉钉企业内部机器人 HTTP 模式回调：
 * - 请求头 timestamp + sign，其中 sign = Base64(HmacSHA256(appSecret, timestamp + "\n" + appSecret))
 * - 请求体与 Stream 模式 data 载荷同构（chatbot schema）
 * - 重试会导致重复推送，由 DedupCache 幂等吸收
 */
import crypto from 'node:crypto';

export const DEFAULT_HTTP_TIMESTAMP_TOLERANCE_MS = 60 * 60 * 1000;

function timestampMs(timestamp) {
  let ts;
  try {
    ts = Number.parseInt(timestamp, 10);
  } catch {
    throw new Error("http mode: invalid timestamp header");
  }
  if (!Number.isFinite(ts)) throw new Error("http mode: invalid timestamp header");
  if (ts < 1e11) ts *= 1000; // 秒级时间戳统一换算为毫秒
  return ts;
}

/**
 * 校验签名与时间戳窗口（<=0 关闭窗口检查），失败抛 Error。
 * @param {string} secret appSecret
 * @param {string} timestamp 请求头 timestamp
 * @param {string} sign 请求头 sign
 * @param {number} toleranceMs 容忍窗口毫秒
 * @param {number} [nowMs] 当前毫秒时间戳（测试注入）
 */
export function verifyHTTPSign(secret, timestamp, sign, toleranceMs = DEFAULT_HTTP_TIMESTAMP_TOLERANCE_MS, nowMs = Date.now()) {
  if (!timestamp || !sign) {
    throw new Error('http mode: missing timestamp/sign headers');
  }
  const ts = timestampMs(timestamp);
  if (toleranceMs > 0 && Math.abs(nowMs - ts) > toleranceMs) {
    throw new Error('http mode: timestamp outside tolerance window');
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(sign);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('http mode: signature mismatch');
  }
}
