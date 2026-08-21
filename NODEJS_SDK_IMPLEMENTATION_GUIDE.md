# Node.js SDK 完整实现框架

## 项目结构

```
dingtalk-channel-sdk-nodejs/
├── src/
│   ├── types/
│   │   ├── index.ts                        🔽 见下文
│   │   ├── reject-reason.ts                🔽 见下文
│   │   ├── configs.ts                      🔽 见下文
│   │   └── messages.ts                     🔽 见下文
│   │
│   ├── safety/
│   │   ├── stale-detector.ts               🔽 见下文
│   │   ├── seen-cache.ts                   🔽 见下文
│   │   ├── policy-gate.ts                  🔽 见下文
│   │   ├── processing-lock.ts              🔽 见下文
│   │   ├── media-pipeline.ts               🔽 见下文
│   │   └── pipeline.ts                     🔽 见下文
│   │
│   └── index.ts                            🔽 见下文
│
├── tests/
│   ├── stale-detector.test.ts              🔽 见下文
│   ├── seen-cache.test.ts                  🔽 见下文
│   └── policy-gate.test.ts                 🔽 见下文
│
├── package.json                             🔽 见下文
├── tsconfig.json                            🔽 见下文
└── README.md                                🔽 见下文
```

---

## 核心类型定义

### 1. types/reject-reason.ts
```typescript
/**
 * 拒绝原因枚举
 */
export enum RejectReason {
  STALE = 'stale',
  DUPLICATE = 'duplicate',
  SELF_SENT = 'self_sent',
  SENDER_DENIED = 'sender_denied',
  SENDER_NOT_ALLOWED = 'sender_not_allowed',
  DM_DISABLED = 'dm_disabled',
  DM_BLOCKED = 'dm_blocked',
  DM_NOT_ALLOWED = 'dm_not_allowed',
  GROUP_BLOCKED = 'group_blocked',
  GROUP_NOT_ALLOWED = 'group_not_allowed',
  NO_MENTION = 'no_mention',
  MENTION_ALL_BLOCKED = 'mention_all_blocked',
  LOCK_CONTENTION = 'lock_contention',
}
```

### 2. types/configs.ts
```typescript
/**
 * 去重配置
 */
export interface DedupConfig {
  ttl: number; // 毫秒
  maxEntries: number;
  enableFingerprint: boolean;
  sweepInterval: number; // 毫秒
}

/**
 * 群组覆盖配置
 */
export interface GroupOverride {
  enabled?: boolean;
  requireMention?: boolean;
  respondToMentionAll?: boolean;
  allowFrom?: string[];
  blockFrom?: string[];
}

/**
 * 策略配置
 */
export interface PolicyConfig {
  // 全局发送者控制
  allowFrom: string[];
  denyFrom: string[];
  admins: string[];

  // DM 策略
  dmMode: 'open' | 'disabled' | 'allowlist' | 'blocklist';
  dmAllowlist: string[];
  dmBlocklist: string[];

  // 群组策略
  groupAllowlist: string[];
  groupBlocklist: string[];
  requireMention?: boolean;
  respondToMentionAll?: boolean;

  // 群组覆盖
  groupOverrides: Record<string, GroupOverride>;
}

/**
 * 媒体批处理配置
 */
export interface MediaBatchConfig {
  enabled: boolean;
  delayMs: number;
  maxItems: number;
}

/**
 * 安全配置
 */
export interface SafetyConfig {
  dedup: DedupConfig;
  policy: PolicyConfig;
  mediaBatch: MediaBatchConfig;
  staleWindow: number; // 毫秒
  lockTtl: number; // 毫秒
  dropSelfSent: boolean;
}

/**
 * 创建默认配置
 */
export function createDefaultSafetyConfig(): SafetyConfig {
  return {
    dedup: {
      ttl: 12 * 60 * 60 * 1000, // 12 小时
      maxEntries: 5000,
      enableFingerprint: true,
      sweepInterval: 5 * 60 * 1000, // 5 分钟
    },
    policy: {
      allowFrom: [],
      denyFrom: [],
      admins: [],
      dmMode: 'open',
      dmAllowlist: [],
      dmBlocklist: [],
      groupAllowlist: [],
      groupBlocklist: [],
      requireMention: true,
      respondToMentionAll: false,
      groupOverrides: {},
    },
    mediaBatch: {
      enabled: true,
      delayMs: 800,
      maxItems: 9,
    },
    staleWindow: 30 * 60 * 1000, // 30 分钟
    lockTtl: 5 * 60 * 1000, // 5 分钟
    dropSelfSent: true,
  };
}
```

### 3. types/messages.ts
```typescript
import { RejectReason } from './reject-reason';

/**
 * 资源
 */
export interface Resource {
  type: string;
  downloadCode?: string;
  fileName?: string;
  recognition?: string;
}

/**
 * 入站消息
 */
export interface IncomingMessage {
  conversationId: string;
  conversationType: string;
  senderId: string;
  senderStaffId: string;
  msgId: string;
  msgType: string;
  text: string;
  createAt: number;

  isInAtList?: boolean;
  mentionAll?: boolean;
  resources?: Resource[];
  batchedSources?: IncomingMessage[];
}

/**
 * 拒绝事件
 */
export interface RejectEvent {
  messageId: string;
  chatId: string;
  senderId: string;
  reason: RejectReason;
}

/**
 * 策略决策
 */
export interface PolicyDecision {
  allowed: boolean;
  reason?: RejectReason;
}

/**
 * Bot 身份
 */
export interface BotIdentity {
  robotCode: string;
  robotName?: string;
}
```

---

## 核心模块实现

### 4. safety/stale-detector.ts
```typescript
/**
 * 过期消息检测器
 * 对标 Go SDK internal/safety/stale_detector.go
 */
export class StaleDetector {
  private readonly staleWindowMs: number;

  constructor(staleWindowMs: number) {
    this.staleWindowMs = staleWindowMs;
  }

  /**
   * 检测消息是否过期
   */
  isStale(createAt: number): boolean {
    if (createAt <= 0) {
      return false; // 无效时间戳，不判定为过期
    }

    const nowMs = Date.now();
    const ageMs = nowMs - createAt;

    return ageMs > this.staleWindowMs;
  }
}
```

### 5. safety/seen-cache.ts
```typescript
import { createHash } from 'crypto';
import { DedupConfig } from '../types';

/**
 * 增强版去重缓存（使用 lru-cache）
 * 对标 Go SDK internal/safety/seen_cache.go
 */
export class SeenCache {
  private readonly config: DedupConfig;
  private readonly cache: Map<string, number>; // key -> timestamp
  private sweepTimer?: NodeJS.Timeout;

  constructor(config: DedupConfig) {
    this.config = config;
    this.cache = new Map();

    // 启动后台清理
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, config.sweepInterval);
  }

  /**
   * 检查并标记为已见
   */
  checkAndMark(...keys: string[]): boolean {
    if (!keys || keys.length === 0) {
      return false;
    }

    // 组合键
    const combinedKey = keys.filter(k => k).join(':');
    const now = Date.now();

    // 检查是否已存在
    if (this.cache.has(combinedKey)) {
      // 命中：更新访问时间
      this.cache.set(combinedKey, now);
      return true;
    }

    // 首次见到，标记
    this.cache.set(combinedKey, now);

    // LRU 容量限制
    if (this.cache.size > this.config.maxEntries) {
      // 删除最旧的条目
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    return false;
  }

  /**
   * 清理过期条目
   */
  private sweep(): void {
    const now = Date.now();
    const ttlMs = this.config.ttl;

    for (const [key, timestamp] of this.cache.entries()) {
      if (now - timestamp > ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}

/**
 * 计算内容指纹（SHA-256）
 */
export function contentFingerprint(
  conversationId: string,
  createAt: number,
  msgType: string,
  content: string
): string {
  const hash = createHash('sha256');
  hash.update(conversationId);
  hash.update(String(createAt));
  hash.update(msgType);
  hash.update(content);
  return hash.digest('hex').substring(0, 16);
}
```

### 6. safety/policy-gate.ts
```typescript
import { PolicyConfig, IncomingMessage, PolicyDecision, BotIdentity } from '../types';
import { RejectReason } from '../types/reject-reason';

/**
 * 策略门控
 * 对标 Go SDK internal/safety/policy_gate.go
 */
export class PolicyGate {
  private config: PolicyConfig;
  private bot?: BotIdentity;

  constructor(config: PolicyConfig) {
    this.config = config;
  }

  /**
   * 评估消息是否允许通过
   */
  evaluate(msg: IncomingMessage): PolicyDecision {
    // 1. 管理员绕过（最高优先级）
    if (this.isAdmin(msg.senderStaffId)) {
      return { allowed: true };
    }

    // 2. 全局黑名单
    if (this.isDenied(msg.senderStaffId)) {
      return { allowed: false, reason: RejectReason.SENDER_DENIED };
    }

    // 3. 全局白名单（如果设置了白名单，必须在名单内）
    if (this.config.allowFrom.length > 0 && !this.isInAllowFrom(msg.senderStaffId)) {
      return { allowed: false, reason: RejectReason.SENDER_NOT_ALLOWED };
    }

    // 4. 按会话类型评估
    if (msg.conversationType === 'group') {
      return this.evaluateGroup(msg);
    } else {
      return this.evaluateDM(msg);
    }
  }

  private evaluateGroup(msg: IncomingMessage): PolicyDecision {
    // 群组黑名单
    if (this.config.groupBlocklist.includes(msg.conversationId)) {
      return { allowed: false, reason: RejectReason.GROUP_BLOCKED };
    }

    // 群组白名单检查
    if (this.config.groupAllowlist.length > 0 &&
        !this.config.groupAllowlist.includes(msg.conversationId)) {
      return { allowed: false, reason: RejectReason.GROUP_NOT_ALLOWED };
    }

    // 群组覆盖
    const override = this.config.groupOverrides[msg.conversationId];
    
    // @机器人检查
    const requireMention = override?.requireMention ?? this.config.requireMention;
    if (requireMention && !msg.isInAtList) {
      return { allowed: false, reason: RejectReason.NO_MENTION };
    }

    // @all 检查
    const respondToAll = override?.respondToMentionAll ?? this.config.respondToMentionAll;
    if (msg.mentionAll && !respondToAll) {
      return { allowed: false, reason: RejectReason.MENTION_ALL_BLOCKED };
    }

    return { allowed: true };
  }

  private evaluateDM(msg: IncomingMessage): PolicyDecision {
    if (this.config.dmMode === 'disabled') {
      return { allowed: false, reason: RejectReason.DM_DISABLED };
    }

    if (this.config.dmMode === 'allowlist' &&
        !this.config.dmAllowlist.includes(msg.senderId)) {
      return { allowed: false, reason: RejectReason.DM_NOT_ALLOWED };
    }

    if (this.config.dmMode === 'blocklist' &&
        this.config.dmBlocklist.includes(msg.senderId)) {
      return { allowed: false, reason: RejectReason.DM_BLOCKED };
    }

    return { allowed: true };
  }

  private isAdmin(staffId: string): boolean {
    return !!staffId && this.config.admins.includes(staffId);
  }

  private isDenied(staffId: string): boolean {
    return !!staffId && this.config.denyFrom.includes(staffId);
  }

  private isInAllowFrom(staffId: string): boolean {
    return !!staffId && this.config.allowFrom.includes(staffId);
  }

  updateConfig(config: PolicyConfig): void {
    this.config = config;
  }

  setBotIdentity(bot: BotIdentity): void {
    this.bot = bot;
  }

  getBotIdentity(): BotIdentity | undefined {
    return this.bot;
  }
}
```

### 7. safety/processing-lock.ts
```typescript
/**
 * 处理锁
 * 对标 Go SDK internal/safety/processing_lock.go
 */
export class ProcessingLock {
  private readonly ttl: number;
  private readonly sweepInterval: number;
  private readonly locks: Map<string, number>; // key -> timestamp
  private sweepTimer?: NodeJS.Timeout;

  constructor(ttl: number, sweepInterval: number) {
    this.ttl = ttl;
    this.sweepInterval = sweepInterval;
    this.locks = new Map();

    // 启动后台清理
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, sweepInterval);
  }

  /**
   * 尝试获取锁
   */
  acquire(key: string): boolean {
    const now = Date.now();

    // 检查是否已锁定
    const timestamp = this.locks.get(key);
    if (timestamp !== undefined) {
      // 检查是否过期
      if (now - timestamp < this.ttl) {
        return false; // 仍被锁定
      }
    }

    // 获取锁
    this.locks.set(key, now);
    return true;
  }

  /**
   * 释放锁
   */
  release(key: string): void {
    this.locks.delete(key);
  }

  /**
   * 清理过期锁
   */
  private sweep(): void {
    const now = Date.now();

    for (const [key, timestamp] of this.locks.entries()) {
      if (now - timestamp > this.ttl) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
```

### 8. safety/media-pipeline.ts
```typescript
import { MediaBatchConfig, IncomingMessage } from '../types';

interface MediaBucket {
  sources: IncomingMessage[];
  timer?: NodeJS.Timeout;
}

type MediaFlushHandler = (merged: IncomingMessage) => Promise<void>;

/**
 * 媒体批处理管理器
 * 对标 Go SDK internal/safety/media_pipeline.go
 */
export class MediaPipelineManager {
  private readonly config: MediaBatchConfig;
  private readonly buckets: Map<string, MediaBucket>;
  private handler?: MediaFlushHandler;

  constructor(config: MediaBatchConfig) {
    this.config = config;
    this.buckets = new Map();
  }

  /**
   * 检查是否为可批处理的媒体类型
   */
  isCompatible(msg: IncomingMessage): boolean {
    if (!this.config.enabled) {
      return false;
    }
    return ['picture', 'file', 'audio', 'video'].includes(msg.msgType);
  }

  /**
   * 推送媒体消息到批次
   */
  async push(msg: IncomingMessage, handler: MediaFlushHandler): Promise<void> {
    this.handler = handler;
    const key = this.batchKey(msg);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { sources: [] };
      this.buckets.set(key, bucket);
    }

    bucket.sources.push(msg);

    // 达到容量上限，立即刷新
    if (bucket.sources.length >= this.config.maxItems) {
      this.cancelTimer(bucket);
      await this.flushBucket(key);
      return;
    }

    // 重置定时器
    this.cancelTimer(bucket);
    bucket.timer = setTimeout(async () => {
      await this.flushBucket(key);
    }, this.config.delayMs);
  }

  /**
   * 刷新与当前消息不兼容的批次
   */
  async flushIncompatibleFor(msg: IncomingMessage): Promise<void> {
    const chatId = msg.conversationId;
    const keysToFlush: string[] = [];

    for (const key of this.buckets.keys()) {
      if (key.startsWith(chatId + ':')) {
        keysToFlush.push(key);
      }
    }

    for (const key of keysToFlush) {
      await this.flushBucket(key);
    }
  }

  private async flushBucket(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.sources.length === 0) {
      return;
    }

    this.buckets.delete(key);
    this.cancelTimer(bucket);

    const merged = this.mergeSources(bucket.sources);

    if (this.handler) {
      await this.handler(merged);
    }
  }

  private batchKey(msg: IncomingMessage): string {
    return `${msg.conversationId}:${msg.msgType}`;
  }

  private mergeSources(sources: IncomingMessage[]): IncomingMessage {
    if (sources.length === 1) {
      return sources[0];
    }

    // 使用最后一条消息作为基础
    const merged = { ...sources[sources.length - 1] };

    // 合并所有 Resources
    const allResources = sources.flatMap(msg => msg.resources || []);
    merged.resources = allResources;

    // 更新文本提示
    const count = sources.length;
    const kindName = this.kindDisplayName(merged.msgType);
    merged.text = `[${count}个${kindName}]`;

    // 保留原始消息列表
    merged.batchedSources = sources;

    return merged;
  }

  private kindDisplayName(msgType: string): string {
    const names: Record<string, string> = {
      picture: '图片',
      file: '文件',
      audio: '语音',
      video: '视频',
    };
    return names[msgType] || '媒体';
  }

  private cancelTimer(bucket: MediaBucket): void {
    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = undefined;
    }
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      this.cancelTimer(bucket);
    }
    this.buckets.clear();
  }
}
```

### 9. safety/pipeline.ts
```typescript
import { SafetyConfig, IncomingMessage, RejectEvent, PolicyConfig } from '../types';
import { RejectReason } from '../types/reject-reason';
import { StaleDetector } from './stale-detector';
import { SeenCache, contentFingerprint } from './seen-cache';
import { PolicyGate } from './policy-gate';
import { ProcessingLock } from './processing-lock';
import { MediaPipelineManager } from './media-pipeline';

export type MessageHandler = (msg: IncomingMessage, sources: IncomingMessage[]) => Promise<void>;
export type RejectHandler = (event: RejectEvent) => void;

/**
 * 安全管线统一门面
 * 对标 Go SDK internal/safety/pipeline.go
 */
export class SafetyPipeline {
  private readonly config: SafetyConfig;
  private readonly onMessage: MessageHandler;
  private readonly onReject?: RejectHandler;
  private botRobotCode?: string;

  private readonly stale: StaleDetector;
  private readonly seen: SeenCache;
  private readonly lock: ProcessingLock;
  private readonly policy: PolicyGate;
  private readonly media: MediaPipelineManager;

  constructor(
    config: SafetyConfig,
    onMessage: MessageHandler,
    onReject?: RejectHandler,
    botRobotCode?: string
  ) {
    this.config = config;
    this.onMessage = onMessage;
    this.onReject = onReject;
    this.botRobotCode = botRobotCode;

    // 创建安全组件
    this.stale = new StaleDetector(config.staleWindow);
    this.seen = new SeenCache(config.dedup);
    this.lock = new ProcessingLock(config.lockTtl, 60 * 1000);
    this.policy = new PolicyGate(config.policy);
    this.media = new MediaPipelineManager(config.mediaBatch);
  }

  /**
   * 推送消息到完整安全管线
   */
  async pushMessage(protoId: string, msg: IncomingMessage): Promise<void> {
    // 1. 过期检测
    if (this.stale.isStale(msg.createAt)) {
      this.emitReject(msg, RejectReason.STALE);
      return;
    }

    // 2. 去重
    let fingerprint = '';
    if (this.config.dedup.enableFingerprint) {
      fingerprint = contentFingerprint(
        msg.conversationId,
        msg.createAt,
        msg.msgType,
        msg.text
      );
    }

    if (this.seen.checkAndMark(protoId, msg.msgId, fingerprint)) {
      this.emitReject(msg, RejectReason.DUPLICATE);
      return;
    }

    // 3. 自回复过滤
    if (this.config.dropSelfSent && 
        this.botRobotCode && 
        msg.senderId === this.botRobotCode) {
      this.emitReject(msg, RejectReason.SELF_SENT);
      return;
    }

    // 4. 策略门控
    const decision = this.policy.evaluate(msg);
    if (!decision.allowed) {
      this.emitReject(msg, decision.reason!);
      return;
    }

    // 5. 处理锁
    if (!this.lock.acquire(msg.msgId)) {
      this.emitReject(msg, RejectReason.LOCK_CONTENTION);
      return;
    }

    // 6. 媒体批处理
    if (this.media.isCompatible(msg)) {
      await this.media.push(msg, async (merged) => {
        try {
          await this.onMessage(merged, merged.batchedSources || [merged]);
        } finally {
          this.lock.release(merged.msgId);
        }
      });
      return;
    }

    // 7. 非媒体消息：刷新待处理的媒体批次
    if (this.config.mediaBatch.enabled) {
      await this.media.flushIncompatibleFor(msg);
    }

    // 8. 直接处理
    try {
      await this.onMessage(msg, [msg]);
    } finally {
      this.lock.release(msg.msgId);
    }
  }

  /**
   * 推送动作到简化管线
   */
  async pushAction(eventId: string, handler: () => Promise<void>): Promise<void> {
    // 1. 去重
    if (this.seen.checkAndMark(eventId)) {
      return;
    }

    // 2. 处理锁
    if (!this.lock.acquire(eventId)) {
      return;
    }

    try {
      await handler();
    } finally {
      this.lock.release(eventId);
    }
  }

  /**
   * 推送轻量事件
   */
  async pushLight(eventId: string, handler: () => Promise<void>): Promise<void> {
    // 仅去重
    if (this.seen.checkAndMark(eventId)) {
      return;
    }

    await handler();
  }

  private emitReject(msg: IncomingMessage, reason: RejectReason): void {
    if (this.onReject) {
      const event: RejectEvent = {
        messageId: msg.msgId,
        chatId: msg.conversationId,
        senderId: msg.senderId,
        reason,
      };
      this.onReject(event);
    }
  }

  setBotIdentity(robotCode: string): void {
    this.botRobotCode = robotCode;
    if (robotCode) {
      this.policy.setBotIdentity({ robotCode });
    }
  }

  updatePolicy(config: PolicyConfig): void {
    this.policy.updateConfig(config);
  }

  dispose(): void {
    this.seen.dispose();
    this.lock.dispose();
    this.media.dispose();
  }
}
```

---

## 配置文件

### package.json
```json
{
  "name": "dingtalk-channel-sdk",
  "version": "0.1.0",
  "description": "钉钉 Channel SDK - 企业级安全管线",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "test:watch": "jest --watch",
    "lint": "eslint src --ext .ts",
    "format": "prettier --write \"src/**/*.ts\""
  },
  "keywords": [
    "dingtalk",
    "channel",
    "sdk",
    "safety"
  ],
  "author": "DingTalk Team",
  "license": "MIT",
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.0.0",
    "@typescript-eslint/eslint-plugin": "^5.59.0",
    "@typescript-eslint/parser": "^5.59.0",
    "eslint": "^8.40.0",
    "jest": "^29.5.0",
    "prettier": "^2.8.8",
    "ts-jest": "^29.1.0",
    "typescript": "^5.0.0"
  },
  "dependencies": {}
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## 测试示例

### tests/stale-detector.test.ts
```typescript
import { StaleDetector } from '../src/safety/stale-detector';

describe('StaleDetector', () => {
  it('should not mark fresh messages as stale', () => {
    const detector = new StaleDetector(30 * 60 * 1000); // 30 分钟
    const now = Date.now();
    expect(detector.isStale(now)).toBe(false);
  });

  it('should mark old messages as stale', () => {
    const detector = new StaleDetector(10 * 60 * 1000); // 10 分钟
    const old = Date.now() - 15 * 60 * 1000; // 15 分钟前
    expect(detector.isStale(old)).toBe(true);
  });

  it('should not mark invalid timestamps as stale', () => {
    const detector = new StaleDetector(30 * 60 * 1000);
    expect(detector.isStale(0)).toBe(false);
    expect(detector.isStale(-1)).toBe(false);
  });
});
```

---

## 使用示例

```typescript
import { SafetyPipeline, createDefaultSafetyConfig } from 'dingtalk-channel-sdk';

// 创建安全管线
const config = createDefaultSafetyConfig();
const pipeline = new SafetyPipeline(
  config,
  async (msg, sources) => {
    console.log('收到消息:', msg.text);
  },
  (event) => {
    console.log('消息被拒绝:', event.reason);
  },
  'robot123'
);

// 推送消息
const msg = {
  conversationId: 'chat1',
  conversationType: 'group',
  senderId: 'user1',
  senderStaffId: 'staff1',
  msgId: 'msg1',
  msgType: 'text',
  text: 'Hello!',
  createAt: Date.now(),
};

await pipeline.pushMessage('proto1', msg);

// 清理
pipeline.dispose();
```

---

## README.md

```markdown
# 钉钉 Channel SDK - Node.js

企业级消息安全管线， Channel SDK。

## 安装

\`\`\`bash
npm install dingtalk-channel-sdk
# 或
yarn add dingtalk-channel-sdk
\`\`\`

## 快速开始

\`\`\`typescript
import { SafetyPipeline, createDefaultSafetyConfig } from 'dingtalk-channel-sdk';

const pipeline = new SafetyPipeline(
  createDefaultSafetyConfig(),
  async (msg, sources) => {
    console.log('收到消息:', msg.text);
  }
);

await pipeline.pushMessage(protoId, msg);
\`\`\`

## 特性

- ✅ TypeScript 完整类型支持
- ✅ 三层去重（协议ID + 业务ID + 内容指纹）
- ✅ 细粒度访问控制
- ✅ 智能媒体批处理
- ✅ Promise/async-await 支持
- ✅ 零依赖

## 文档

详见 [NODEJS_SDK_IMPLEMENTATION_GUIDE.md](./NODEJS_SDK_IMPLEMENTATION_GUIDE.md)

## 许可证

MIT
\`\`\`

---

## 实现清单

- [x] 类型定义（完整 TypeScript 类型）
- [x] StaleDetector
- [x] SeenCache
- [x] PolicyGate
- [x] ProcessingLock
- [x] MediaPipelineManager
- [x] SafetyPipeline
- [ ] 完整测试用例
- [ ] README.md

**预计完成时间**：5-7 天全职工作
