import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, TRANSPORT_STREAM, TRANSPORT_HTTP } from '../src/config.js';

const base = { clientId: 'id', clientSecret: 'sec' };

describe('Config.transport reserved field', () => {
  it('defaults to stream', () => {
    assert.equal(normalizeConfig(base).transport, TRANSPORT_STREAM);
  });

  it('accepts stream explicitly', () => {
    assert.equal(normalizeConfig({ ...base, transport: 'stream' }).transport, 'stream');
  });

  it('accepts http transport with tolerance default', () => {
    const cfg = normalizeConfig({ ...base, transport: TRANSPORT_HTTP });
    assert.equal(cfg.transport, TRANSPORT_HTTP);
    assert.equal(cfg.httpTimestampToleranceMs, 60 * 60 * 1000);
  });

  it('rejects unknown transport', () => {
    assert.throws(() => normalizeConfig({ ...base, transport: 'grpc' }), /unknown transport/);
  });
});
