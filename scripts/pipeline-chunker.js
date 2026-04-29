'use strict';

/**
 * pipeline-chunker.js
 *
 * Pure-function text chunker for semantic embedding pipelines.
 * No I/O. No DB. No file reads.
 *
 * Plan: docs/plans/2026-04-26-chunker-loader-plan.md
 *
 * @function chunkText
 * @param {string} text          - Input text to split into chunks.
 * @param {number} ceilingChars  - Hard maximum chars per chunk (default 1400).
 *                                 Use 560 for JSONL/tool_result sources (DECISION-004).
 * @param {string} contentType   - 'prose' (default) or 'tool_result'.
 *                                 In 'tool_result' mode, rule 2 (code-fence) is the
 *                                 primary split; rule 4 (sentence) is suppressed to
 *                                 prevent splits on periods inside code expressions.
 * @returns {Array<{content: string, chunkIdx: number}>}
 *
 * Boundary priority (first match wins within ceilingChars window):
 *   1. Markdown heading  /^#{1,6}\s/m  - split BEFORE heading; heading starts new chunk.
 *   2. Code-fence        /^```/m       - split at CLOSING fence; fence line ends chunk.
 *   3. Paragraph break   double-newline - split at blank line.
 *   4. Sentence break    [.!?] + space + uppercase - split after punctuation.
 *   5. Hard-split at ceilingChars with overlap re-seed of Math.floor(ceilingChars * 0.14).
 *
 * In 'tool_result' mode: rule 2 fires first (before 1, 3, 4). Rule 4 never fires.
 */

const HEADING_RE = /^#{1,6} /m;
const FENCE_RE   = /^```/m;

/**
 * @param {string} text
 * @param {number} [ceilingChars=1400]
 * @param {string} [contentType='prose']
 * @returns {Array<{content: string, chunkIdx: number}>}
 */
function chunkText(text, ceilingChars, contentType) {
  if (ceilingChars === undefined) ceilingChars = 1400;
  if (contentType === undefined) contentType = 'prose';

  if (!text || text.length === 0) return [];

  const overlapSize = Math.floor(ceilingChars * 0.14);
  const isToolResult = contentType === 'tool_result';

  // Rule 1 pre-pass: always split on heading boundaries unconditionally.
  // The heading line BEGINS the new section (split before it).
  const sections = splitOnHeadings(text);

  // For each heading-delimited section, apply rules 2-5 based on size.
  const rawChunks = [];
  for (const section of sections) {
    chunkSection(section, ceilingChars, overlapSize, isToolResult, rawChunks);
  }

  // Renumber and drop empty chunks
  const result = [];
  for (const content of rawChunks) {
    const trimmed = content.trimEnd();
    if (trimmed.length > 0) {
      result.push({ content: trimmed, chunkIdx: result.length });
    }
  }

  return result;
}

/**
 * Split text into sections at each markdown heading (rule 1).
 * The heading line begins the new section.
 * Returns an array of strings; each string is a heading + its body content.
 */
function splitOnHeadings(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Heading at i > 0: flush current section, start new one with this heading
    if (i > 0 && HEADING_RE.test(line + '\n')) {
      if (current.length > 0) {
        sections.push(current.join('\n'));
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current.join('\n'));
  }
  return sections.length > 0 ? sections : [text];
}

/**
 * Chunk a single section (already heading-bounded) using rules 2-5.
 * Appends raw content strings to the out array.
 */
function chunkSection(text, ceilingChars, overlapSize, isToolResult, out) {
  let remaining = text;
  let overlapSeed = '';

  while (remaining.length > 0) {
    const workingText = overlapSeed + remaining;
    overlapSeed = '';

    if (workingText.length <= ceilingChars) {
      const trimmed = workingText.trimEnd();
      if (trimmed.length > 0) out.push(trimmed);
      break;
    }

    const windowLen = ceilingChars;
    let splitAt = -1;
    let ruleUsed = 0;

    if (isToolResult) {
      // Rule 2 first in tool_result mode
      splitAt = findClosingFence(workingText, windowLen);
      if (splitAt > 0) ruleUsed = 2;
    }

    if (splitAt === -1 && !isToolResult) {
      // Rule 2 in prose mode (after rule 1 which is handled by pre-pass)
      splitAt = findClosingFence(workingText, windowLen);
      if (splitAt > 0) ruleUsed = 2;
    }

    if (splitAt === -1) {
      // Rule 3: paragraph break
      const paraIdx = findParagraphBreak(workingText, windowLen);
      if (paraIdx > 0) {
        splitAt = paraIdx;
        ruleUsed = 3;
      }
    }

    if (splitAt === -1 && !isToolResult) {
      // Rule 4: sentence break (suppressed in tool_result)
      const sentIdx = findSentenceBreak(workingText, windowLen);
      if (sentIdx > 0) {
        splitAt = sentIdx;
        ruleUsed = 4;
      }
    }

    if (splitAt === -1) {
      // Rule 5: hard split with overlap seed
      ruleUsed = 5;
      splitAt = ceilingChars;
      overlapSeed = workingText.slice(splitAt - overlapSize, splitAt);
    }

    const chunk = workingText.slice(0, splitAt).trimEnd();
    if (chunk.length > 0) out.push(chunk);

    remaining = workingText.slice(splitAt);

    // Strip leading newlines after non-heading splits
    if (ruleUsed !== 1) {
      remaining = remaining.replace(/^\n+/, '');
    }
  }
}

/**
 * Find a closing code-fence within window.
 * Returns the index just after the closing fence line so the fence ends the chunk.
 */
function findClosingFence(text, windowLen) {
  const sub = text.slice(0, windowLen);
  const lines = sub.split('\n');
  let pos = 0;
  let inFence = false;
  let closingFenceEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      if (!inFence) {
        inFence = true;
      } else {
        closingFenceEnd = pos + line.length + 1;
        inFence = false;
      }
    }
    pos += line.length + 1;
  }
  return closingFenceEnd;
}

/**
 * Find the last paragraph break within window.
 * Returns the index just after the double-newline.
 */
function findParagraphBreak(text, windowLen) {
  const sub = text.slice(0, windowLen);
  const idx = sub.lastIndexOf('\n\n');
  if (idx === -1) return -1;
  return idx + 2;
}

/**
 * Find the last sentence break within window.
 * Split after the punctuation char.
 */
function findSentenceBreak(text, windowLen) {
  const sub = text.slice(0, windowLen);
  const re = /[.!?](?=\s+[A-Z])/g;
  let lastIdx = -1;
  let m;
  while ((m = re.exec(sub)) !== null) {
    lastIdx = m.index + 1;
  }
  return lastIdx;
}

module.exports = { chunkText };

// ---------------------------------------------------------------------------
// Inline tests -- run with: node scripts/pipeline-chunker.js
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');
  let testCount = 0;

  function test(name, fn) {
    fn();
    testCount++;
  }

  // Test 1: Empty input returns [].
  test('empty input returns []', function() {
    assert.deepStrictEqual(chunkText(''), [], 'empty string should return []');
    assert.deepStrictEqual(chunkText('', 1400), [], 'empty with ceiling should return []');
  });

  // Test 2: Short input returns one chunk with chunkIdx 0.
  test('short input returns single chunk', function() {
    const input = 'Hello world. This is a short input under 50 chars.';
    const result = chunkText(input, 1400);
    assert.strictEqual(result.length, 1, 'short input should produce exactly 1 chunk');
    assert.strictEqual(result[0].chunkIdx, 0, 'single chunk should have chunkIdx 0');
    assert.strictEqual(result[0].content, input.trimEnd(), 'content should match trimmed input');
  });

  // Test 3: Two H2 headings produce 2 chunks (chunkIdx 0 and 1).
  test('two H2 headings produce 2 chunks', function() {
    const h1 = '## First Heading';
    const h2 = '## Second Heading';
    const input = h1 + '\n\nSome content here.\n\n' + h2 + '\n\nMore content.';
    const result = chunkText(input, 1400);
    assert.strictEqual(result.length, 2, 'expected 2 chunks for 2 headings, got ' + result.length);
    assert.strictEqual(result[0].chunkIdx, 0, 'first chunk chunkIdx should be 0');
    assert.strictEqual(result[1].chunkIdx, 1, 'second chunk chunkIdx should be 1');
    assert.ok(result[0].content.startsWith(h1),
      'first chunk should start with ## First Heading');
    assert.ok(result[1].content.startsWith(h2),
      'second chunk should start with ## Second Heading');
  });

  // Test 4: 1500-char string with para break around 800 produces 2 chunks both <= 1400.
  test('1500-char string with para break around 800 produces 2 chunks', function() {
    const part1 = 'A'.repeat(790) + '\n\n';
    const part2 = 'B'.repeat(700);
    const input = part1 + part2;
    assert.ok(input.length > 1400, 'input should be >1400 chars, got ' + input.length);
    const result = chunkText(input, 1400);
    assert.strictEqual(result.length, 2, 'expected 2 chunks, got ' + result.length);
    assert.ok(result[0].content.length <= 1400, 'chunk 0 length exceeds 1400: ' + result[0].content.length);
    assert.ok(result[1].content.length <= 1400, 'chunk 1 length exceeds 1400: ' + result[1].content.length);
  });

  // Test 5: prose + fenced code block + prose; fence content preserved intact.
  test('fenced code block content preserved across chunks', function() {
    const prose1 = 'Leading prose paragraph sets up context.\n\n';
    const fenceBody = 'const x = 1;\n'.repeat(4);
    const bt = String.fromCharCode(96).repeat(3);
    const fence = bt + 'js\n' + fenceBody + bt + '\n\n';
    const prose2 = 'Trailing prose paragraph wraps things up.\n\n';
    const input = prose1 + fence + prose2;
    const result = chunkText(input, 300);
    assert.ok(result.length >= 1, 'should produce at least 1 chunk');
    const joined = result.map(function(c) { return c.content; }).join('\n');
    assert.ok(joined.includes('const x = 1;'), 'fence content should be preserved in chunks');
    assert.ok(joined.includes(bt + 'js'), 'opening fence marker should be preserved');
  });

  // Test 6: 3000-char no-whitespace string forces rule 5 with overlap.
  test('3000-char no-whitespace string hard-splits with overlap', function() {
    const input = 'x'.repeat(3000);
    const result = chunkText(input, 1400);
    assert.ok(result.length >= 2, 'expected >= 2 chunks, got ' + result.length);
    for (let i = 0; i < result.length; i++) {
      assert.ok(result[i].content.length <= 1400,
        'chunk ' + i + ' length ' + result[i].content.length + ' exceeds ceiling');
    }
    const overlapSize = Math.floor(1400 * 0.14);
    const expectedOverlap = result[0].content.slice(-overlapSize);
    assert.ok(result[1].content.startsWith(expectedOverlap),
      'chunk 1 should start with last ' + overlapSize + ' chars of chunk 0 (overlap seed)');
  });

  // Test 7: tool_result mode - splits on fence, not on period inside code.
  test('tool_result mode splits on fence boundary not sentence period', function() {
    const longProse = 'This is leading text that explains the tool result context. '.repeat(8);
    const bt = String.fromCharCode(96).repeat(3);
    const code = bt + 'js\nconst x = 1;\nconst y = 2;\n' + bt + '\n';
    const moreProse = 'Additional explanation follows here.';
    const input = longProse + code + moreProse;
    const result = chunkText(input, 200, 'tool_result');
    assert.ok(result.length >= 1, 'should produce at least 1 chunk');
    const joined = result.map(function(c) { return c.content; }).join('\n');
    assert.ok(joined.includes('const x = 1;'), 'const x = 1; should be intact in tool_result mode');
    assert.ok(joined.includes('const y = 2;'), 'const y = 2; should be intact in tool_result mode');
  });

  // Test 8: tiny ceiling forces rule 5; produces multiple chunks each <= 5 chars.
  test('tiny ceiling forces rule 5 hard splits', function() {
    const result = chunkText('hello world.', 5);
    assert.ok(result.length > 1, 'expected multiple chunks with ceiling=5, got ' + result.length);
    for (let i = 0; i < result.length; i++) {
      assert.ok(result[i].content.length <= 5,
        'chunk ' + i + ' length ' + result[i].content.length + ' exceeds ceiling of 5');
    }
  });

  // Test 9: 560 ceiling produces strictly more chunks than 1400.
  test('560 ceiling produces strictly more chunks than 1400', function() {
    const para = 'This is a paragraph of reasonable length. It contains multiple sentences. ';
    const input = (para.repeat(5) + '\n\n').repeat(4);
    const result1400 = chunkText(input, 1400);
    const result560  = chunkText(input, 560);
    assert.ok(result560.length > result1400.length,
      '560-ceiling (' + result560.length + ' chunks) should exceed 1400-ceiling (' + result1400.length + ' chunks)');
  });

  console.log('chunker tests passed (' + testCount + ' tests)');
}
