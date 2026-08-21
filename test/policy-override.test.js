import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GroupOverride, PolicyConfig, PolicyGate, RejectReason } from '../src/safety/policy.js';

const msg = (cid, { sender = 'staff-1', inAtList = true } = {}) => ({
  conversationId: cid,
  conversationType: 'group',
  senderId: sender,
  isInAtList: inAtList,
});

describe('group overrides', () => {
  it('explicit override admits group in allowlist mode', () => {
    const gate = new PolicyGate(
      new PolicyConfig({
        groupAllowlist: ['cid-allowed'],
        groupOverrides: { 'cid-other': new GroupOverride() },
      })
    );
    assert.equal(gate.evaluate(msg('cid-other')).allowed, true);
    const d = gate.evaluate(msg('cid-unknown'));
    assert.equal(d.allowed, false);
    assert.equal(d.reason, RejectReason.GROUP_NOT_ALLOWED);
  });

  it('blocklist never overridden', () => {
    const gate = new PolicyGate(
      new PolicyConfig({
        groupBlocklist: ['cid-bad'],
        groupOverrides: { 'cid-bad': new GroupOverride({ enabled: true }) },
      })
    );
    const d = gate.evaluate(msg('cid-bad'));
    assert.equal(d.allowed, false);
    assert.equal(d.reason, RejectReason.GROUP_BLOCKED);
  });

  it('override disables group', () => {
    const gate = new PolicyGate(
      new PolicyConfig({ groupOverrides: { 'cid-1': new GroupOverride({ enabled: false }) } })
    );
    const d = gate.evaluate(msg('cid-1'));
    assert.equal(d.allowed, false);
    assert.equal(d.reason, RejectReason.GROUP_DISABLED);
  });

  it('override requireMention beats global', () => {
    const gate = new PolicyGate(
      new PolicyConfig({
        requireMention: true,
        groupOverrides: {
          'cid-1': new GroupOverride({ requireMention: false }),
          'cid-2': new GroupOverride({ requireMention: true }),
        },
      })
    );
    assert.equal(gate.evaluate(msg('cid-1', { inAtList: false })).allowed, true);
    assert.equal(gate.evaluate(msg('cid-2', { inAtList: false })).reason, RejectReason.NO_MENTION);
    assert.equal(gate.evaluate(msg('cid-3', { inAtList: false })).reason, RejectReason.NO_MENTION);
  });

  it('override allowFrom filters senders', () => {
    const gate = new PolicyGate(
      new PolicyConfig({ groupOverrides: { 'cid-1': new GroupOverride({ allowFrom: ['staff-1'] }) } })
    );
    assert.equal(gate.evaluate(msg('cid-1', { sender: 'staff-1' })).allowed, true);
    assert.equal(gate.evaluate(msg('cid-1', { sender: 'staff-2' })).reason, RejectReason.SENDER_NOT_ALLOWED);
  });
});

describe('group override blockFrom', () => {
  it('blockFrom beats allowFrom', () => {
    const gate = new PolicyGate(
      new PolicyConfig({
        groupOverrides: {
          'cid-1': new GroupOverride({ allowFrom: ['staff-1', 'staff-2'], blockFrom: ['staff-2'] }),
        },
      })
    );
    assert.equal(gate.evaluate(msg('cid-1', { sender: 'staff-1' })).allowed, true);
    assert.equal(gate.evaluate(msg('cid-1', { sender: 'staff-2' })).reason, RejectReason.SENDER_BLOCKED);
  });
});
