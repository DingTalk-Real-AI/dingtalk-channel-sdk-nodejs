// 消息表情回应（"🤔Thinking"状态章）——移植自 dws connect_card.go（hermes 同款）。
// 仅支持人发的消息（机器人自己的消息会 500）；best-effort，不为装饰失败整条回复。

export const EMOTION_THINKING = '🤔Thinking';
export const EMOTION_DONE = '🥳Done';

export class Emotion {
  constructor(cfg, cards) {
    this.cfg = cfg;
    this.cards = cards;
  }

  async #send(conversationId, msgId, name, recall) {
    if (!conversationId || !msgId) throw new Error('emotion needs openConversationId and openMsgId');
    return this.cards.callPublic('POST', recall ? '/v1.0/robot/emotion/recall' : '/v1.0/robot/emotion/reply', {
      robotCode: this.cfg.clientId,
      openConversationId: conversationId,
      openMsgId: msgId,
      emotionType: 2,
      emotionName: name,
      textEmotion: {
        emotionId: '2659900',
        emotionName: name,
        text: name,
        backgroundId: 'im_bg_1',
      },
    });
  }

  markThinking(conversationId, msgId) {
    return this.#send(conversationId, msgId, EMOTION_THINKING, false);
  }

  async markDone(conversationId, msgId) {
    await this.#send(conversationId, msgId, EMOTION_THINKING, true).catch(() => {});
    return this.#send(conversationId, msgId, EMOTION_DONE, false);
  }
}
