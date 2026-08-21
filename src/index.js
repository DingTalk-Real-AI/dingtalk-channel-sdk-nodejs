// dingtalk-channel-sdk-nodejs 公共入口。

export { DingTalkChannel } from './channel.js';
export { normalizeIncoming, parseContent, CONVERSATION_DM, CONVERSATION_GROUP } from './normalize/message.js';
export { Reply } from './reply.js';
export { CardStreamer, CardClient, ApiError } from './card.js';
export { normalizeForCard, fixNewlines, ensureTableBlankLines } from './outbound/markdown.js';
export { Deduper } from './safety/dedup.js';
export { TokenBucket } from './ratelimit.js';
export { OapiClient } from './media.js';
export { ProactiveSender } from './send.js';
export { Emotion, EMOTION_THINKING, EMOTION_DONE } from './emotion.js';
export * from './config.js';


export { ChannelError, ErrorCode, classifyError, isRetryable, isReplyTargetGone, isFormatError } from './errors.js';
export { BotIdentity, BotIdentityProvider } from './bot-identity.js';
export { LifecycleHooks } from './lifecycle.js';
export { PolicyConfig, PolicyGate, PolicyDecision, RejectEvent, RejectReason } from './safety/policy.js';
export { ProcessingLock } from './safety/processing-lock.js';
export { BatchConfig, BatchedMessage, MessageBatcher } from './safety/batching.js';
export { assertPublicUrl } from './safety/ssrf-guard.js';
export { ChatQueueConfig, MediaBatchConfig } from './safety/chat-queue.js';
export { RetryOptions, retry } from './outbound/retry.js';
export { splitWithCodeFences } from './outbound/splitter.js';
