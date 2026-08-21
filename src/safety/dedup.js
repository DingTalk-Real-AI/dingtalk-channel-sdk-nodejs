/** 双层去重：messageId（协议层）+ msgId（业务层），TTL 5min（SPEC §3.2 / E6）。
 * 支持 LRU 驱逐（MaxEntries）与后台定时清理（SweepInterval）。 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_SWEEP_MS = 5 * 60 * 1000;

export class Deduper {
  constructor(ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, sweepIntervalMs = DEFAULT_SWEEP_MS) {
    if (typeof ttlMs === 'object' && ttlMs !== null) {
      const o = ttlMs;
      this.ttl = o.ttl ?? DEFAULT_TTL_MS;
      this.maxEntries = o.maxEntries ?? DEFAULT_MAX_ENTRIES;
      this.sweepIntervalMs = o.sweepInterval ?? DEFAULT_SWEEP_MS;
    } else {
      this.ttl = ttlMs;
      this.maxEntries = maxEntries;
      this.sweepIntervalMs = sweepIntervalMs;
    }
    this.seen = new Map();
    this._timer = null;
    this._startSweeper();
  }

  _startSweeper() {
    if (this._timer !== null) return;
    this._timer = setInterval(() => this._sweep(), this.sweepIntervalMs);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  _sweep() {
    const now = Date.now();
    for (const [k, ts] of this.seen) {
      if (now - ts > this.ttl) this.seen.delete(k);
    }
  }

  /** 命中（重复）返回 true。 */
  checkAndMark(...keys) {
    const now = Date.now();
    for (const [k, ts] of this.seen) {
      if (now - ts > this.ttl) this.seen.delete(k);
    }
    let isDuplicate = false;
    for (const k of keys) {
      if (k && this.seen.has(k)) {
        isDuplicate = true;
        const ts = this.seen.get(k);
        this.seen.delete(k);
        this.seen.set(k, ts);
      }
    }
    if (isDuplicate) return true;
    for (const k of keys) {
      if (k) {
        if (this.seen.has(k)) this.seen.delete(k);
        this.seen.set(k, now);
        if (this.seen.size > this.maxEntries) {
          const oldest = this.seen.keys().next().value;
          this.seen.delete(oldest);
        }
      }
    }
    return false;
  }

  dispose() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.seen.clear();
  }
}
