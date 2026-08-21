/**
 * 机器人身份。
 */

/**
 * 机器人身份信息
 */
export class BotIdentity {
  /**
   * @param {Object} params
   * @param {string} params.robotCode - 机器人代码（对应 ClientID）
   * @param {string} params.robotName - 机器人名称
   * @param {string} params.avatar - 机器人头像 URL
   */
  constructor({ robotCode, robotName, avatar }) {
    this.robotCode = robotCode || '';
    this.robotName = robotName || '';
    this.avatar = avatar || '';
  }
}

/**
 * 机器人身份提供者（带缓存）
 */
export class BotIdentityProvider {
  /**
   * @param {object} cfg - normalized config
   * @param {TokenProvider} tokens
   */
  constructor(cfg, tokens) {
    this.cfg = cfg;
    this.tokens = tokens;
    this._cacheTTL = 30 * 60 * 1000; // 30 分钟
    this._minRefreshInterval = 60 * 1000; // 1 分钟
    this._identity = null;
    this._fetchedAt = 0;
    this._lastFailureAt = 0;
    this._lock = Promise.resolve();
  }

  /**
   * 获取机器人身份（带缓存）
   * @returns {Promise<BotIdentity|null>}
   */
  async get() {
    if (this._isCacheFresh()) {
      return this._identity;
    }

    // 简单的互斥锁
    const prevLock = this._lock;
    let releaseLock;
    this._lock = new Promise(resolve => { releaseLock = resolve; });
    await prevLock;

    try {
      // Double-check after acquiring lock
      if (this._isCacheFresh()) {
        return this._identity;
      }

      const now = Date.now();
      if (this._shouldThrottleRefresh(now)) {
        return this._identity;
      }

      try {
        const identity = await this._fetch();
        this._identity = identity;
        this._fetchedAt = Date.now();
        this._lastFailureAt = 0;
        return identity;
      } catch (err) {
        this._lastFailureAt = Date.now();
        if (this._identity) {
          // 有旧缓存，返回旧的（降级）
          this.cfg.debug('failed to refresh bot identity, using stale cache: %s', err.message);
          return this._identity;
        }
        this.cfg.debug('failed to fetch bot identity: %s', err.message);
        return null;
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * @private
   */
  _isCacheFresh() {
    if (!this._identity) {
      return false;
    }
    if (this._cacheTTL <= 0) {
      return true;
    }
    return (Date.now() - this._fetchedAt) < this._cacheTTL;
  }

  /**
   * @private
   */
  _shouldThrottleRefresh(now) {
    if (this._lastFailureAt === 0) {
      return false;
    }
    if (this._minRefreshInterval <= 0) {
      return false;
    }
    return (now - this._lastFailureAt) < this._minRefreshInterval;
  }

  /**
   * 从 API 获取机器人身份信息
   * @private
   */
  async _fetch() {
    const token = await this.tokens.get();
    const headers = {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    };

    const resp = await fetch(`${this.cfg.apiBase}/v1.0/robot/robotInfo`, { headers });
    if (!resp.ok) {
      throw new Error(`robotInfo: http ${resp.status}`);
    }

    const data = await resp.json();
    const robotCode = data.robotCode || this.cfg.clientId;
    const robotName = data.robotName || 'bot';
    const avatar = data.avatar || '';

    return new BotIdentity({ robotCode, robotName, avatar });
  }
}
