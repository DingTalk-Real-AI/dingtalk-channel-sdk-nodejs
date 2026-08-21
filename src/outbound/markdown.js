// 钉钉 AI 卡片渲染器 Markdown 归一化（SPEC §7 / E10），移植自官方 connector。

const tableDividerRe = /^\s*\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)+\|?\s*$/;
const tableRowRe = /^\s*\|?.*\|.*\|?\s*$/;
const blockStartRe =
  /^(\s{0,3}(?:[-*+]|\d+[.)])[ ])|(\s{0,3}\|)|(\s{0,3}#{1,6}\s)|(\s{0,3}(?:[-*_])\s*(?:[-*_])\s*(?:[-*_]))/;
const fenceRe = /^\s{0,3}```/;
const quoteRe = /^\s{0,3}>\s?/;

function isDivider(line) {
  return Boolean(line) && line.includes('|') && tableDividerRe.test(line);
}

/** 表格分隔行前若无空行则插入（否则钉钉不渲染表格）。 */
export function ensureTableBlankLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1] ?? '';
    if (
      tableRowRe.test(lines[i]) &&
      isDivider(next) &&
      i > 0 &&
      lines[i - 1].trim() !== '' &&
      !tableRowRe.test(lines[i - 1])
    ) {
      out.push('');
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** 单 \n → <br>，按代码块/引用/块语法行约定处理。 */
export function fixNewlines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  // 1. 合并连续引用行（代码块外），<br> 连接，续行去 > 前缀。
  const merged = [];
  let pending = [];
  let inCode = false;
  const flush = () => {
    if (pending.length > 0) {
      merged.push(pending.join('<br>'));
      pending = [];
    }
  };
  for (const line of lines) {
    const isFence = fenceRe.test(line);
    if (inCode) {
      flush();
      merged.push(line);
      if (isFence) inCode = false;
      continue;
    }
    if (isFence) {
      flush();
      merged.push(line);
      inCode = true;
      continue;
    }
    if (quoteRe.test(line)) {
      if (pending.length === 0) pending.push(line);
      else pending.push(line.replace(quoteRe, ''));
    } else {
      flush();
      merged.push(line);
    }
  }
  flush();

  // 2. 逐行决定分隔符。
  let out = '';
  inCode = false;
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i];
    const nextInCode = fenceRe.test(cur) ? !inCode : inCode;
    if (i < merged.length - 1) {
      const next = merged[i + 1];
      const keepNewline =
        nextInCode || cur === '' || next === '' || fenceRe.test(next) || blockStartRe.test(next);
      out += cur + (keepNewline ? '\n' : '<br>');
    } else {
      out += cur;
    }
    inCode = nextInCode;
  }
  return out;
}

export function normalizeForCard(content) {
  return fixNewlines(ensureTableBlankLines(content));
}
