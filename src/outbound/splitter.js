const FENCE_RE = /^```(\w*)$/;
const HEADING_RE = /^#{1,6}\s/;

export function splitWithCodeFences(text, limit) {
  if (!text || text.length <= limit) return [text];

  const lines = text.split('\n');
  const chunks = [];
  let buffer = [];
  let bufferLen = 0;
  let inFence = false;
  let fenceLang = '';

  function pushLine(line) {
    if (buffer.length > 0) bufferLen += 1;
    buffer.push(line);
    bufferLen += line.length;
  }

  function flush() {
    if (buffer.length === 0) return;
    let chunk = buffer.join('\n');
    if (inFence) {
      chunk += '\n```';
    }
    chunks.push(chunk);
    if (inFence) {
      const opener = '```' + fenceLang;
      buffer = [opener];
      bufferLen = opener.length;
    } else {
      buffer = [];
      bufferLen = 0;
    }
  }

  for (const line of lines) {
    const isFence = FENCE_RE.test(line);

    if (isFence && inFence) {
      inFence = false;
      fenceLang = '';
      pushLine(line);
      if (bufferLen > limit) {
        flush();
      }
      continue;
    }

    const isHeading = !inFence && HEADING_RE.test(line);
    const addLen = buffer.length > 0 ? 1 + line.length : line.length;

    if (buffer.length > 0) {
      if (isHeading && bufferLen > limit * 0.75) {
        flush();
      } else if (bufferLen + addLen > limit) {
        flush();
      }
    }

    if (isFence) {
      inFence = true;
      fenceLang = line.match(FENCE_RE)[1] || '';
    }

    pushLine(line);
  }

  if (buffer.length > 0) {
    flush();
  }

  return chunks;
}
