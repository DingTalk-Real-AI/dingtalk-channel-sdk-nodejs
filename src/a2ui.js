// 按 dingtalk-aicard 的公开接入方式，通过显式配置的 DWS 身份发送 A2UI。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const A2UI_FLOW_STATUSES = Object.freeze([
  'PROCESSING', 'INPUTTING', 'FINISH', 'EXECUTING', 'ERROR',
  'ABORTED', 'TIMEOUT', 'CONFIRMING', 'CONFIRMED',
]);
const operations = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];
const missingId = '回执未包含可用的 bizId；请保留回执并核实服务端标识，不要自动重发创建请求。';

function identifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`${name} 必须是非空标识`);
  }
  return value.trim();
}

/** 接受消息对象或 JSON 字符串；只检查信封，组件校验使用 dingtalk-aicard。 */
export function serializeA2UIMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('A2UI 消息必须是非空数组');
  }
  const strings = messages.map((message, index) => {
    let parsed;
    let encoded;
    try {
      encoded = typeof message === 'string' ? message : JSON.stringify(message, (_key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('JSON 不允许非有限数值');
        return value;
      });
      parsed = JSON.parse(encoded);
    } catch {
      throw new TypeError(`A2UI 消息 ${index} 不是有效 JSON`);
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || parsed.version !== 'v1.0') {
      throw new TypeError(`A2UI 消息 ${index} 必须是 version=v1.0 的对象`);
    }
    const keys = operations.filter((key) => Object.hasOwn(parsed, key));
    if (keys.length !== 1) throw new TypeError(`A2UI 消息 ${index} 必须包含一个操作`);
    identifier(parsed[keys[0]]?.surfaceId, 'surfaceId');
    return encoded;
  });
  const content = JSON.stringify(strings);
  // DWS 的 --content 使用一个 argv 参数，为跨平台执行保留空间。
  if (Buffer.byteLength(content, 'utf8') > 65536) throw new RangeError('DWS A2UI content 超过 64 KiB');
  return content;
}

function envelopeChain(receipt) {
  const chain = [];
  let value = receipt;
  for (let i = 0; i < 5 && value && typeof value === 'object' && !Array.isArray(value); i++) {
    chain.push(value);
    if (value.success === false || value.ok === false || value.isError === true || value.error || value.dry_run === true || value.dryRun === true
      || (value.outcome !== undefined && !['success', 'pending'].includes(value.outcome))) {
      throw new Error('DWS 返回失败回执');
    }
    value = value.data ?? value.result;
  }
  if (!chain.some(item => item.success === true || item.ok === true)) {
    throw new Error('DWS 回执未明确确认接受请求；发送结果可能未知，请核实后再重试');
  }
  return chain;
}

/**
 * 可选发送通道。command 是可执行文件及固定前缀参数，始终使用 argv，不调用 shell。
 * DWS 必须单独安装、登录；发送身份由 profile 决定，与机器人应用 Token 独立。
 */
export class DwsA2UIClient {
  constructor({ command = ['dws'], profile, timeoutMs = 30000 } = {}) {
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))) {
      throw new TypeError('command 必须是非空字符串数组');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须大于 0');
    this.command = [...command];
    this.profile = profile === undefined ? undefined : identifier(profile, 'profile');
    if (this.profile?.includes(',')) throw new TypeError('A2UI 发送只允许一个 DWS Profile');
    this.timeoutMs = timeoutMs;
  }

  async #invoke(args) {
    const argv = [...this.command.slice(1), 'chat', 'message', ...args, '--format=json', '--yes'];
    if (this.profile) argv.push(`--profile=${this.profile}`);
    let stdout;
    try {
      ({ stdout } = await run(this.command[0], argv, {
        timeout: this.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
      }));
    } catch {
      // 原始 stderr/命令行可能携带业务内容或凭据，不纳入错误文本；写入结果可能未知。
      throw new Error('DWS 执行失败或超时；发送结果可能未知，请核实后再重试');
    }
    let receipt;
    try { receipt = JSON.parse(stdout); } catch {
      throw new Error('DWS 输出不是 JSON；发送结果可能未知，请保留现场核实');
    }
    if (!receipt || Array.isArray(receipt) || typeof receipt !== 'object') {
      throw new Error('DWS 回执必须是 JSON 对象');
    }
    envelopeChain(receipt);
    return receipt;
  }

  /** target: {openDingTalkId} 单聊，或 {conversationId} 群聊，恰好一个。 */
  async sendCard(target, messages) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['openDingTalkId', 'conversationId'].includes(key))) {
      throw new TypeError('A2UI target 使用 openDingTalkId 或 conversationId，不接受 userId');
    }
    const dm = target.openDingTalkId !== undefined;
    const group = target.conversationId !== undefined;
    if (dm === group) throw new TypeError('A2UI target 必须恰好选择一个接收目标');
    const flag = dm ? 'open-dingtalk-id' : 'conversation-id';
    const id = identifier(dm ? target.openDingTalkId : target.conversationId, flag);
    const content = serializeA2UIMessages(messages);
    const receipt = await this.#invoke(['send-a2ui-card', `--${flag}=${id}`, `--content=${content}`]);
    const value = envelopeChain(receipt).reverse().find((item) => typeof item.bizId === 'string' && item.bizId.trim() && !/[\x00-\x1f\x7f]/.test(item.bizId));
    const bizId = value?.bizId.trim();
    return { bizId, receipt, updateWarning: bizId ? undefined : missingId };
  }

  /** 更新原卡片；messages 是同一 Surface 的增量，FINISH 用于完成静态卡片。 */
  async updateCard(bizId, messages, flowStatus) {
    const id = identifier(bizId, 'bizId');
    let status = String(flowStatus).trim().toUpperCase();
    if (/^[1-9]$/.test(status)) status = A2UI_FLOW_STATUSES[Number(status) - 1];
    if (!A2UI_FLOW_STATUSES.includes(status)) throw new TypeError('不支持的 A2UI flowStatus');
    const content = serializeA2UIMessages(messages);
    return this.#invoke(['update-a2ui-card', `--biz-id=${id}`, `--content=${content}`, `--flow-status=${status}`]);
  }
}
