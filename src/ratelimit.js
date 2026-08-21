/** 全局令牌桶 + QpsLimit 退避（SPEC §6）。 */

export class TokenBucket {
  constructor(rate) {
    this.rate = rate;
    this.tokens = rate;
    this.lastRefill = Date.now();
    this.backoffEnd = 0;
  }

  #refill(now) {
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);
      this.lastRefill = now;
    }
  }

  /** 取一个令牌，无令牌时等待。 */
  async waitFor() {
    for (;;) {
      const now = Date.now();
      if (now < this.backoffEnd) {
        await sleep(this.backoffEnd - now);
        continue;
      }
      this.#refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(((1 - this.tokens) / this.rate) * 1000);
    }
  }

  triggerBackoff(backoffMs = 2000) {
    this.backoffEnd = Date.now() + backoffMs;
    this.tokens = 0;
    this.lastRefill = this.backoffEnd;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
