// E10：Markdown 归一化规则。

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForCard } from '../src/index.js';

test('normalizeForCard', () => {
  assert.equal(normalizeForCard('a\nb'), 'a<br>b');
  assert.equal(normalizeForCard('a\n\nb'), 'a\n\nb');
  assert.equal(normalizeForCard('```\nx\ny\n```'), '```\nx\ny\n```');
  assert.equal(normalizeForCard('- a\n- b'), '- a\n- b');
  assert.equal(normalizeForCard('# T\nbody'), '# T<br>body');
  assert.equal(normalizeForCard('body\n# T'), 'body\n# T');
  assert.equal(normalizeForCard('a\n> q1\n> q2\nb'), 'a<br>> q1<br>q2<br>b');
  assert.equal(
    normalizeForCard('x\n| a | b |\n| -- | -- |\n| 1 | 2 |'),
    'x\n\n| a | b |\n| -- | -- |\n| 1 | 2 |',
  );
});
