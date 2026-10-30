import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import {
  parseInlineMarkdownTokens,
  pickCodeSpanColor,
  wrapTextByWords,
  type InlineToken,
} from './markdownTokens.js';
export * from './markdownTokens.js';
interface StyledWord {
  segments: InlineToken[];
  width: number;
}
function splitTokensIntoStyledWords(
  tokens: readonly InlineToken[],
): StyledWord[] {
  const words: StyledWord[] = [];
  let currentSegments: InlineToken[] = [];
  let currentWidth = 0;
  const flushWord = () => {
    if (currentSegments.length > 0) {
      words.push({
        segments: currentSegments,
        width: currentWidth,
      });
      currentSegments = [];
      currentWidth = 0;
    }
  };
  for (const tok of tokens) {
    const parts = tok.content.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        flushWord();
      } else {
        const w = stringWidth(part);
        currentSegments.push({ ...tok, content: part });
        currentWidth += w;
      }
    }
  }
  flushWord();
  return words;
}
function forceSplitOverlongStyledWord(
  word: StyledWord,
  maxWidth: number,
): StyledWord[] {
  const limit = Math.max(1, maxWidth);
  if (word.width <= limit) {
    return [word];
  }
  const result: StyledWord[] = [];
  let curSegments: InlineToken[] = [];
  let curWidth = 0;
  const pushPiece = (segTemplate: InlineToken, textPiece: string, w: number) => {
    if (!textPiece) return;
    const last = curSegments[curSegments.length - 1];
    if (
      last &&
      last.kind === segTemplate.kind &&
      (last.kind !== 'color' ||
        (segTemplate.kind === 'color' && last.color === segTemplate.color))
    ) {
      last.content += textPiece;
    } else {
      curSegments.push({ ...segTemplate, content: textPiece });
    }
    curWidth += w;
  };
  for (const seg of word.segments) {
    for (const ch of seg.content) {
      const chW = Math.max(0, stringWidth(ch));
      if (curSegments.length > 0 && curWidth + chW > limit) {
        result.push({ segments: curSegments, width: curWidth });
        curSegments = [];
        curWidth = 0;
      }
      pushPiece(seg, ch, chW);
    }
  }
  if (curSegments.length > 0) {
    result.push({ segments: curSegments, width: curWidth });
  }
  return result.length > 0 ? result : [word];
}
function joinStyledWordsIntoTokens(words: readonly StyledWord[]): InlineToken[] {
  const out: InlineToken[] = [];
  const pushToken = (tok: InlineToken) => {
    if (!tok.content) return;
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === tok.kind &&
      (prev.kind !== 'color' ||
        (tok.kind === 'color' && prev.color === tok.color))
    ) {
      prev.content += tok.content;
    } else {
      out.push({ ...tok });
    }
  };
  words.forEach((w, idx) => {
    if (idx > 0) {
      pushToken({ kind: 'text', content: ' ' });
    }
    for (const seg of w.segments) {
      pushToken(seg);
    }
  });
  return out;
}
export function wrapInlineTokensByWords(
  tokens: readonly InlineToken[],
  maxWidth: number,
  firstLineMaxWidth?: number,
): InlineToken[][] {
  const safeMax = Math.max(1, maxWidth);
  const safeFirst = Math.max(1, firstLineMaxWidth ?? safeMax);
  const words = splitTokensIntoStyledWords(tokens);
  if (words.length === 0) {
    return [[]];
  }
  const lines: InlineToken[][] = [];
  let currentWords: StyledWord[] = [];
  let currentWidth = 0;
  let currentLimit = safeFirst;
  const flushLine = () => {
    lines.push(joinStyledWordsIntoTokens(currentWords));
    currentWords = [];
    currentWidth = 0;
    currentLimit = safeMax;
  };
  for (const word of words) {
    if (currentWords.length === 0) {
      if (word.width <= currentLimit) {
        currentWords.push(word);
        currentWidth = word.width;
      } else {
        const pieces = forceSplitOverlongStyledWord(word, currentLimit);
        for (let i = 0; i < pieces.length - 1; i++) {
          currentWords = [pieces[i]!];
          flushLine();
        }
        const tail = pieces[pieces.length - 1]!;
        currentWords = [tail];
        currentWidth = tail.width;
      }
    } else if (currentWidth + 1 + word.width <= currentLimit) {
      currentWords.push(word);
      currentWidth += 1 + word.width;
    } else {
      flushLine();
      if (word.width <= currentLimit) {
        currentWords = [word];
        currentWidth = word.width;
      } else {
        const pieces = forceSplitOverlongStyledWord(word, currentLimit);
        for (let i = 0; i < pieces.length - 1; i++) {
          currentWords = [pieces[i]!];
          flushLine();
        }
        const tail = pieces[pieces.length - 1]!;
        currentWords = [tail];
        currentWidth = tail.width;
      }
    }
  }
  if (currentWords.length > 0) {
    flushLine();
  }
  return lines.length > 0 ? lines : [[]];
}
export const InlineTokensSpan: React.FC<{
  tokens: readonly InlineToken[];
  baseColor?: string;
}> = ({ tokens, baseColor = 'white' }) => {
  return (
    <Text color={baseColor}>
      {tokens.map((tok, i) => {
        if (tok.kind === 'bold') {
          if (tok.content.includes('`')) {
            const inner = parseInlineMarkdownTokens(tok.content);
            return (
              <Text key={i} bold color="whiteBright">
                {inner.map((inTok, j) =>
                  inTok.kind === 'code' ? (
                    <Text key={j} bold color={pickCodeSpanColor(inTok.content)}>
                      {inTok.content}
                    </Text>
                  ) : (
                    <Text key={j} bold color="whiteBright">
                      {inTok.content}
                    </Text>
                  ),
                )}
              </Text>
            );
          }
          return (
            <Text key={i} bold color="whiteBright">
              {tok.content}
            </Text>
          );
        }
        if (tok.kind === 'code') {
          return (
            <Text key={i} color={pickCodeSpanColor(tok.content)} bold>
              {tok.content}
            </Text>
          );
        }
        if (tok.kind === 'italic') {
          if (tok.content.includes('`')) {
            const inner = parseInlineMarkdownTokens(tok.content);
            return (
              <Text key={i} italic color="gray">
                {inner.map((inTok, j) =>
                  inTok.kind === 'code' ? (
                    <Text
                      key={j}
                      italic
                      color={pickCodeSpanColor(inTok.content)}
                    >
                      {inTok.content}
                    </Text>
                  ) : (
                    <Text key={j} italic color="gray">
                      {inTok.content}
                    </Text>
                  ),
                )}
              </Text>
            );
          }
          return (
            <Text key={i} italic color="gray">
              {tok.content}
            </Text>
          );
        }
        if (tok.kind === 'color') {
          return (
            <Text key={i} color={tok.color} bold>
              {tok.content}
            </Text>
          );
        }

        if (tok.kind === 'link') {
          return (
            <Text key={i} color="cyan" underline>
              {tok.content}
            </Text>
          );
        }
        return (
          <Text key={i} color={baseColor}>
            {tok.content}
          </Text>
        );
      })}
    </Text>
  );
};
export const InlineMarkdownText: React.FC<{
  line: string;
  baseColor?: string;
}> = ({ line, baseColor = 'white' }) => {
  const tokens = parseInlineMarkdownTokens(line);
  return <InlineTokensSpan tokens={tokens} baseColor={baseColor} />;
};
export interface RichMarkdownBlockProps {
  text: string;
  firstLinePrefix?: React.ReactNode;
  firstLinePrefixWidth?: number;
  firstLineSuffix?: React.ReactNode;
  availableWidth?: number;
  baseTextColor?: string;
}
export const RichMarkdownBlock: React.FC<RichMarkdownBlockProps> = React.memo(({
  text,
  firstLinePrefix,
  firstLinePrefixWidth = 2,
  firstLineSuffix,
  availableWidth,
  baseTextColor = 'white',
}) => {
  const totalCols = process.stdout.columns ?? 100;
  const contentWidth = Math.max(16, availableWidth ?? totalCols - 4);
  const continuationIndent = '  ';
  const continuationIndentWidth = 2;
  const lf = String.fromCharCode(10);
  const cr = String.fromCharCode(13);
  const allRawLines = text
    .split(lf)
    .map((l) => (l.endsWith(cr) ? l.slice(0, -1) : l));
  while (allRawLines.length > 0 && allRawLines[0]!.trim().length === 0) {
    allRawLines.shift();
  }
  while (
    allRawLines.length > 0 &&
    allRawLines[allRawLines.length - 1]!.trim().length === 0
  ) {
    allRawLines.pop();
  }
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  let renderedFirstLine = false;
  let previousWasBlank = false;
  const flushCodeBlock = (keyIndex: number) => {
    const boxWidth = Math.max(16, contentWidth);
    const innerCodeWidth = Math.max(8, boxWidth - 4);
    const wrappedCodeLines: string[] = [];
    for (const cLine of codeBlockLines) {
      if (cLine.trim().length === 0) {
        wrappedCodeLines.push('');
      } else {
        wrappedCodeLines.push(...wrapTextByWords(cLine, innerCodeWidth));
      }
    }
    elements.push(
      <Box
        key={`code-${keyIndex}`}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        width={boxWidth}
        marginLeft={0}
        marginY={0}
      >
        {codeBlockLang ? (
          <Text color="yellow" dimColor>
            {codeBlockLang}
          </Text>
        ) : null}
        {wrappedCodeLines.map((cl, cIdx) => (
          <Text key={cIdx} color="cyan">
            {cl || ' '}
          </Text>
        ))}
      </Box>,
    );
    codeBlockLines = [];
    codeBlockLang = '';
    previousWasBlank = false;
  };
  allRawLines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        codeBlockLines = [];
      } else {
        inCodeBlock = false;
        flushCodeBlock(idx);
      }
      return;
    }
    if (inCodeBlock) {
      codeBlockLines.push(rawLine);
      return;
    }
    if (trimmed.length === 0) {
      if (!previousWasBlank && renderedFirstLine) {
        previousWasBlank = true;
        elements.push(
          <Box key={`empty-${idx}`} height={1}>
            <Text>{' '}</Text>
          </Box>,
        );
      }
      return;
    }
    previousWasBlank = false;
    const attachPrefix = !renderedFirstLine;
    if (attachPrefix) {
      renderedFirstLine = true;
    }
    const line0PrefixW = attachPrefix
      ? firstLinePrefixWidth
      : continuationIndentWidth;
    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      const headingText = (headingMatch[2] ?? '').replace(/\*\*/g, '');
      const wrappedHeading = wrapTextByWords(
        headingText,
        Math.max(8, contentWidth - continuationIndentWidth),
        Math.max(8, contentWidth - line0PrefixW),
      );
      wrappedHeading.forEach((hLine, hIdx) => {
        const isFirst = attachPrefix && hIdx === 0;
        const isLast = attachPrefix && hIdx === wrappedHeading.length - 1;
        elements.push(
          <Box key={`h-${idx}-${hIdx}`} flexDirection="row">
            {isFirst ? firstLinePrefix : <Text>{continuationIndent}</Text>}
            <Text bold color="cyan">
              {hLine}
            </Text>
            {isLast ? firstLineSuffix : null}
          </Box>,
        );
      });
      return;
    }
    const bulletMatch = /^(\s*)([-*]|\*(?=\s))\s+(.*)$/.exec(rawLine);
    if (bulletMatch) {
      const rawIndent = bulletMatch[1] ?? '';
      const indentSpaces = ' '.repeat(Math.min(6, rawIndent.length));
      const itemContent = (bulletMatch[3] ?? '').trim();
      const bulletLabel = `${indentSpaces}- `;
      const bulletLabelW = stringWidth(bulletLabel);
      const firstW = Math.max(
        8,
        contentWidth - (attachPrefix ? firstLinePrefixWidth : 0) - bulletLabelW,
      );
      const contIndentStr = `${continuationIndent}${indentSpaces}  `;
      const contW = Math.max(8, contentWidth - stringWidth(contIndentStr));
      const tokens = parseInlineMarkdownTokens(itemContent);
      const wrappedTokenLines = wrapInlineTokensByWords(tokens, contW, firstW);
      wrappedTokenLines.forEach((tokLine, lIdx) => {
        const isFirst = lIdx === 0;
        const isLast = attachPrefix && lIdx === wrappedTokenLines.length - 1;
        elements.push(
          <Box key={`li-${idx}-${lIdx}`} flexDirection="row">
            {isFirst ? (
              <>
                {attachPrefix ? firstLinePrefix : <Text>{continuationIndent}</Text>}
                <Text color="cyan" bold>
                  {bulletLabel}
                </Text>
              </>
            ) : (
              <Text>{contIndentStr}</Text>
            )}
            <InlineTokensSpan tokens={tokLine} baseColor={baseTextColor} />
            {isLast ? firstLineSuffix : null}
          </Box>,
        );
      });
      return;
    }
    const numMatch = /^(\s*\d+[.)])\s+(.*)$/.exec(rawLine);
    if (numMatch) {
      const numLabel = `${(numMatch[1] ?? '').trim()} `;
      const itemContent = (numMatch[2] ?? '').trim();
      const numLabelW = stringWidth(numLabel);
      const firstW = Math.max(
        8,
        contentWidth - (attachPrefix ? firstLinePrefixWidth : 0) - numLabelW,
      );
      const contIndentStr = `${continuationIndent}${' '.repeat(numLabelW)}`;
      const contW = Math.max(8, contentWidth - stringWidth(contIndentStr));
      const tokens = parseInlineMarkdownTokens(itemContent);
      const wrappedTokenLines = wrapInlineTokensByWords(tokens, contW, firstW);
      wrappedTokenLines.forEach((tokLine, lIdx) => {
        const isFirst = lIdx === 0;
        const isLast = attachPrefix && lIdx === wrappedTokenLines.length - 1;
        elements.push(
          <Box key={`ol-${idx}-${lIdx}`} flexDirection="row">
            {isFirst ? (
              <>
                {attachPrefix ? firstLinePrefix : <Text>{continuationIndent}</Text>}
                <Text color="cyan" bold>
                  {numLabel}
                </Text>
              </>
            ) : (
              <Text>{contIndentStr}</Text>
            )}
            <InlineTokensSpan tokens={tokLine} baseColor={baseTextColor} />
            {isLast ? firstLineSuffix : null}
          </Box>,
        );
      });
      return;
    }
    const tokens = parseInlineMarkdownTokens(trimmed);
    const wrappedTokenLines = wrapInlineTokensByWords(
      tokens,
      Math.max(8, contentWidth - continuationIndentWidth),
      Math.max(8, contentWidth - line0PrefixW),
    );
    wrappedTokenLines.forEach((tokLine, lIdx) => {
      const isFirst = attachPrefix && lIdx === 0;
      const isLast = attachPrefix && lIdx === wrappedTokenLines.length - 1;
      elements.push(
        <Box key={`p-${idx}-${lIdx}`} flexDirection="row">
          {isFirst ? firstLinePrefix : <Text>{continuationIndent}</Text>}
          <InlineTokensSpan tokens={tokLine} baseColor={baseTextColor} />
          {isLast ? firstLineSuffix : null}
        </Box>,
      );
    });
  });
  if (inCodeBlock && codeBlockLines.length > 0) {
    flushCodeBlock(allRawLines.length);
  }
  if (elements.length === 0) {
    return (
      <Box flexDirection="row">
        {firstLinePrefix}
        <Text color={baseTextColor}>{text}</Text>
        {firstLineSuffix}
      </Box>
    );
  }
  return <Box flexDirection="column">{elements}</Box>;
});
