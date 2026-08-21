/** Stream 线协议帧结构（SPEC §2.2）。 */

export const SUB_CALLBACK = 'CALLBACK';
export const SUB_SYSTEM = 'SYSTEM';

export function successAck(messageId, data = '') {
  return {
    code: 200,
    headers: { contentType: 'application/json', messageId },
    message: 'ok',
    data: data === '' ? '{"success":true}' : data,
  };
}

export function topicOf(frame) {
  return frame?.headers?.topic || '';
}

export function messageIdOf(frame) {
  return frame?.headers?.messageId || '';
}
