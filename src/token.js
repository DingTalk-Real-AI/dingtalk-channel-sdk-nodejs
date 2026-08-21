/** access token 获取与缓存（SPEC §8）。 */

export class TokenProvider {
  /** @param {import('./config.js').normalizedConfig} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.token = '';
    this.expiresAt = 0;
  }

  async get() {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const resp = await fetch(`${this.cfg.apiBase}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.cfg.clientId, appSecret: this.cfg.clientSecret }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.accessToken) {
      throw new Error(`accessToken: http ${resp.status} ${JSON.stringify(body)}`);
    }
    this.token = body.accessToken;
    this.expiresAt = Date.now() + (body.expireIn || 7200) * 1000;
    return this.token;
  }
}
