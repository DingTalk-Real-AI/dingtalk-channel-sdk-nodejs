// 使用 DWS 的指定 Profile 发送示例卡片并完成原卡片，不需要机器人凭据。
import { readFileSync } from 'node:fs';
import { DwsA2UIClient } from '../src/index.js';

const profile = process.env.DWS_PROFILE;
const recipient = process.env.DWS_OPEN_DINGTALK_ID;
if (!profile || !recipient) throw new Error('请设置 DWS_PROFILE 和 DWS_OPEN_DINGTALK_ID');
const client = new DwsA2UIClient({ command: [process.env.DWS_BIN || 'dws'], profile });
const messages = JSON.parse(readFileSync(new URL('./a2ui-card.json', import.meta.url), 'utf8'));
const result = await client.sendCard({ openDingTalkId: recipient }, messages);
if (!result.bizId) throw new Error(result.updateWarning);
const delta = JSON.parse(readFileSync(new URL('./a2ui-update.json', import.meta.url), 'utf8'));
await client.updateCard(result.bizId, delta, 'FINISH');
console.log(`示例卡片已完成，bizId=${result.bizId}`);
