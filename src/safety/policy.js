/**
 * 策略门控。
 */

/**
 * 拒绝原因枚举
 */
export const RejectReason = {
  GROUP_NOT_ALLOWED: 'group_not_allowed',
  GROUP_BLOCKED: 'group_blocked',
  GROUP_DISABLED: 'group_disabled',
  NO_MENTION: 'no_mention',
  MENTION_ALL: 'mention_all_blocked',
  DM_DISABLED: 'dm_disabled',
  DM_NOT_ALLOWED: 'dm_not_allowed',
  DM_BLOCKED: 'dm_blocked',
  SENDER_NOT_ALLOWED: 'sender_not_allowed',
  SENDER_BLOCKED: 'sender_blocked',
};

/**
 * 策略评估结果
 */
export class PolicyDecision {
  /**
   * @param {Object} params
   * @param {boolean} params.allowed - 是否允许
   * @param {string|null} params.reason - 拒绝原因
   */
  constructor({ allowed, reason = null }) {
    this.allowed = allowed;
    this.reason = reason;
  }
}

/**
 * 消息被策略拒绝时触发的事件
 */
export class RejectEvent {
  /**
   * @param {Object} params
   * @param {string} params.messageId - 消息 ID
   * @param {string} params.chatId - 会话 ID
   * @param {string} params.senderId - 发送者 ID
   * @param {string} params.reason - 拒绝原因
   */
  constructor({ messageId, chatId, senderId, reason }) {
    this.messageId = messageId;
    this.chatId = chatId;
    this.senderId = senderId;
    this.reason = reason;
  }
}

/**
 * 单群策略覆盖。零值字段沿用全局配置。
 */
export class GroupOverride {
  /**
   * @param {Object} params
   * @param {boolean|null} params.enabled - 显式禁用该群（false = 拒绝该群所有消息）
   * @param {boolean|null} params.requireMention - 覆盖该群的 @机器人 要求
   * @param {string[]} params.allowFrom - 该群内发送者白名单
   * @param {string[]} params.blockFrom - 该群内发送者黑名单（先于 allowFrom 检查）
   */
  constructor({ enabled = null, requireMention = null, allowFrom = [], blockFrom = [] } = {}) {
    this.enabled = enabled;
    this.requireMention = requireMention;
    this.allowFrom = allowFrom;
    this.blockFrom = blockFrom;
  }
}

/**
 * 控制消息准入策略
 */
export class PolicyConfig {
  /**
   * @param {Object} params
   * @param {string[]} params.groupAllowlist - 群聊白名单（空 = 允许所有群）
   * @param {string[]} params.groupBlocklist - 群聊黑名单
   * @param {boolean} params.requireMention - 群聊是否需要 @机器人（默认 true）
   * @param {boolean} params.respondToMentionAll - 是否响应 @所有人（默认 false）
   * @param {string} params.dmMode - 单聊模式："open" | "disabled" | "allowlist" | "blocklist"
   * @param {string[]} params.dmAllowlist - 单聊白名单
   * @param {string[]} params.dmBlocklist - 单聊黑名单
   * @param {Object<string, GroupOverride>} params.groupOverrides - 按群覆盖（显式条目可在白名单模式下放行，黑名单永不例外）
   */
  constructor({
    groupAllowlist = [],
    groupBlocklist = [],
    requireMention = true,
    respondToMentionAll = false,
    dmMode = 'open',
    dmAllowlist = [],
    dmBlocklist = [],
    groupOverrides = {},
  } = {}) {
    this.groupAllowlist = groupAllowlist;
    this.groupBlocklist = groupBlocklist;
    this.requireMention = requireMention;
    this.respondToMentionAll = respondToMentionAll;
    this.dmMode = dmMode;
    this.dmAllowlist = dmAllowlist;
    this.dmBlocklist = dmBlocklist;
    this.groupOverrides = groupOverrides;
  }
}

/**
 * 消息策略门控
 */
export class PolicyGate {
  /**
   * @param {PolicyConfig} cfg
   */
  constructor(cfg) {
    this._cfg = cfg;
  }

  /**
   * 评估消息是否允许通过
   * @param {IncomingMessage} msg
   * @returns {PolicyDecision}
   */
  evaluate(msg) {
    if (msg.conversationType === 'group') {
      return this._evaluateGroup(msg);
    }
    return this._evaluateDM(msg);
  }

  /**
   * @private
   */
  _evaluateGroup(msg) {
    // 黑名单检查（最高优先级，群覆盖不可豁免）
    if (this._cfg.groupBlocklist.includes(msg.conversationId)) {
      return new PolicyDecision({ allowed: false, reason: RejectReason.GROUP_BLOCKED });
    }

    // 群覆盖（显式条目可在白名单模式下放行该群）
    const ov = this._cfg.groupOverrides[msg.conversationId];

    // 白名单检查：全局白名单命中，或存在显式群条目
    if (this._cfg.groupAllowlist.length > 0) {
      if (!this._cfg.groupAllowlist.includes(msg.conversationId) && !ov) {
        return new PolicyDecision({ allowed: false, reason: RejectReason.GROUP_NOT_ALLOWED });
      }
    }

    if (ov && ov.enabled === false) {
      return new PolicyDecision({ allowed: false, reason: RejectReason.GROUP_DISABLED });
    }

    // @机器人检查（群覆盖优先）
    let requireMention = this._cfg.requireMention;
    if (ov && ov.requireMention !== null && ov.requireMention !== undefined) {
      requireMention = ov.requireMention;
    }
    if (requireMention && !msg.isInAtList) {
      return new PolicyDecision({ allowed: false, reason: RejectReason.NO_MENTION });
    }

    // 群内发送者黑名单（先于白名单）
    if (ov && ov.blockFrom.includes(msg.senderId)) {
      return new PolicyDecision({ allowed: false, reason: RejectReason.SENDER_BLOCKED });
    }

    // 群内发送者白名单
    if (ov && ov.allowFrom.length > 0) {
      if (!ov.allowFrom.includes(msg.senderId)) {
        return new PolicyDecision({ allowed: false, reason: RejectReason.SENDER_NOT_ALLOWED });
      }
    }

    // @所有人检查（钉钉无明确 mentionAll 字段，保留配置接口）
    // respondToMentionAll 暂时未使用

    return new PolicyDecision({ allowed: true });
  }

  /**
   * @private
   */
  _evaluateDM(msg) {
    const mode = this._cfg.dmMode || 'open';

    if (mode === 'disabled') {
      return new PolicyDecision({
        allowed: false,
        reason: RejectReason.DM_DISABLED,
      });
    }

    if (mode === 'allowlist') {
      if (!this._cfg.dmAllowlist.includes(msg.senderId)) {
        return new PolicyDecision({
          allowed: false,
          reason: RejectReason.DM_NOT_ALLOWED,
        });
      }
    }

    if (mode === 'blocklist') {
      if (this._cfg.dmBlocklist.includes(msg.senderId)) {
        return new PolicyDecision({
          allowed: false,
          reason: RejectReason.DM_BLOCKED,
        });
      }
    }

    return new PolicyDecision({ allowed: true });
  }

  /**
   * 更新策略配置
   * @param {PolicyConfig} cfg
   */
  updateConfig(cfg) {
    this._cfg = cfg;
  }

  /**
   * 获取当前策略配置
   * @returns {PolicyConfig}
   */
  getConfig() {
    return this._cfg;
  }
}
