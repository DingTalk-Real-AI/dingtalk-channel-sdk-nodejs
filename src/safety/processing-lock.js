/**
 * 处理锁。
 */

/**
 * 短时 TTL 内存锁，防止同一事件并发处理
 */
export class ProcessingLock {
  /**
   * @param {Object} params
   * @param {number} params.ttl - 锁的有效期（毫秒），默认 5 分钟
   * @param {number} params.sweepInterval - 清理间隔（毫秒），默认 1 分钟
   */
  constructor({ ttl = 5 * 60 * 1000, sweepInterval = 60 * 1000 } = {}) {
    this._ttl = ttl;
    this._sweepInterval = sweepInterval;
    this._locks = new Map(); // id -> expireAt
    this._sweeperTimer = null;
  }

  /**
   * 获取锁，成功返回 true，已被持有返回 false
   * @param {string} id
   * @returns {boolean}
   */
  acquire(id) {
    const now = Date.now();
    const expireAt = this._locks.get(id);
    if (expireAt !== undefined && expireAt > now) {
      return false;
    }
    this._locks.set(id, now + this._ttl);
    return true;
  }

  /**
   * 释放锁
   * @param {string} id
   */
  release(id) {
    this._locks.delete(id);
  }

  /**
   * 启动后台清理任务
   */
  startSweeper() {
    if (this._sweeperTimer !== null) {
      return;
    }
    this._sweeperTimer = setInterval(() => {
      this._sweep();
    }, this._sweepInterval);
  }

  /**
   * 停止后台清理任务
   */
  stopSweeper() {
    if (this._sweeperTimer !== null) {
      clearInterval(this._sweeperTimer);
      this._sweeperTimer = null;
    }
  }

  /**
   * 清理过期锁
   * @private
   */
  _sweep() {
    const now = Date.now();
    for (const [id, expireAt] of this._locks.entries()) {
      if (expireAt <= now) {
        this._locks.delete(id);
      }
    }
  }

  /**
   * 清理所有锁并停止后台任务
   */
  dispose() {
    this.stopSweeper();
    this._locks.clear();
  }
}
