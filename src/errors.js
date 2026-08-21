// 错误分类。

/**
 * 结构化错误码
 * @enum {string}
 */
export const ErrorCode = Object.freeze({
  TARGET_REVOKED: 'target_revoked',
  PERMISSION_DENIED: 'permission_denied',
  FORMAT_ERROR: 'format_error',
  RATE_LIMITED: 'rate_limited',
  QPS_LIMITED: 'qps_limited',
  SEND_TIMEOUT: 'send_timeout',
  SSRF_BLOCKED: 'ssrf_blocked',
  UNKNOWN: 'unknown',
});

/**
 * 结构化错误，携带错误码、原始错误和上下文
 */
export class ChannelError extends Error {
  /**
   * @param {string} code - ErrorCode
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.cause = cause;
  }

  toString() {
    let s = `ChannelError(code=${this.code}): ${this.message}`;
    if (this.cause) {
      s += ` | cause: ${this.cause}`;
    }
    return s;
  }
}

/**
 * 从 HTTP 状态码推断错误码
 * @param {number} status
 * @returns {string|null}
 */
function classifyFromStatus(status) {
  if (status === 400) return ErrorCode.FORMAT_ERROR;
  if (status === 401 || status === 403) return ErrorCode.PERMISSION_DENIED;
  if (status === 404) return ErrorCode.TARGET_REVOKED;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  return null;
}

/**
 * 将原始错误分类为结构化 ChannelError
 * @param {Error} err
 * @returns {ChannelError}
 */
export function classifyError(err) {
  if (err instanceof ChannelError) {
    return err;
  }

  const msg = (err.message || '').toLowerCase();

  // 尝试从 API 错误中提取 status code
  const status = err.status || err.statusCode;
  if (status) {
    const errMsg = (err.message || '').toLowerCase();
    if (errMsg.includes('qps') || errMsg.includes('flow control')) {
      return new ChannelError(ErrorCode.QPS_LIMITED, err.message, err);
    }
    const code = classifyFromStatus(Number(status));
    if (code) {
      return new ChannelError(code, err.message, err);
    }
  }

  // 从错误消息推断
  if (msg.includes('status 429') || msg.includes('too many requests')) {
    return new ChannelError(ErrorCode.RATE_LIMITED, err.message, err);
  }
  if (msg.includes('status 401') || msg.includes('status 403')) {
    return new ChannelError(ErrorCode.PERMISSION_DENIED, err.message, err);
  }
  if (msg.includes('status 400')) {
    return new ChannelError(ErrorCode.FORMAT_ERROR, err.message, err);
  }
  if (msg.includes('status 404')) {
    return new ChannelError(ErrorCode.TARGET_REVOKED, err.message, err);
  }

  if (msg.includes('timeout') || msg.includes('deadline exceeded')) {
    return new ChannelError(ErrorCode.SEND_TIMEOUT, err.message, err);
  }

  return new ChannelError(ErrorCode.UNKNOWN, err.message, err);
}

/**
 * 判断错误是否可重试
 * @param {Error} err
 * @returns {boolean}
 */
export function isRetryable(err) {
  if (err instanceof ChannelError) {
    return [
      ErrorCode.RATE_LIMITED,
      ErrorCode.QPS_LIMITED,
      ErrorCode.UNKNOWN,
      ErrorCode.SEND_TIMEOUT,
    ].includes(err.code);
  }
  return true;
}

/**
 * 判断是否为回复目标已撤回
 * @param {Error} err
 * @returns {boolean}
 */
export function isReplyTargetGone(err) {
  return err instanceof ChannelError && err.code === ErrorCode.TARGET_REVOKED;
}

/**
 * 判断是否为格式错误
 * @param {Error} err
 * @returns {boolean}
 */
export function isFormatError(err) {
  return err instanceof ChannelError && err.code === ErrorCode.FORMAT_ERROR;
}
