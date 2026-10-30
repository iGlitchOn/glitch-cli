import stringWidth from 'string-width';
export type InlineColorName =
  | 'cyan'
  | 'magenta'
  | 'green'
  | 'yellow'
  | 'red'
  | 'blue';
export type InlineToken =
  | { kind: 'text'; content: string }
  | { kind: 'bold'; content: string }
  | { kind: 'italic'; content: string }
  | { kind: 'code'; content: string }
  | { kind: 'link'; content: string; url: string }
  | {
      kind: 'color';
      color: InlineColorName;
      content: string;
    };

export interface RenderedLineLinkSpan {
  url: string;
  startCol: number;
  endCol: number;
}
const VALID_COLORS = new Set<string>([
  'cyan',
  'magenta',
  'green',
  'yellow',
  'red',
  'blue',
]);
export function measureTextWidth(text: string): number {
  if (!text) return 0;
  return stringWidth(text);
}
export function splitLongWordByWidth(word: string, maxWidth: number): string[] {
  const limit = Math.max(1, maxWidth);
  if (stringWidth(word) <= limit) {
    return [word];
  }
  const parts: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const ch of word) {
    const chW = Math.max(0, stringWidth(ch));
    if (current.length > 0 && currentWidth + chW > limit) {
      parts.push(current);
      current = ch;
      currentWidth = chW;
    } else {
      current += ch;
      currentWidth += chW;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts.length > 0 ? parts : [''];
}
export function wrapTextByWords(
  text: string,
  maxWidth: number,
  firstLineMaxWidth?: number,
): string[] {
  const safeMax = Math.max(1, maxWidth);
  const safeFirst = Math.max(1, firstLineMaxWidth ?? safeMax);
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawParagraphs = normalized.split('\n');
  const result: string[] = [];
  let isVeryFirstLine = true;
  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (trimmed.length === 0) {
      result.push('');
      isVeryFirstLine = false;
      continue;
    }
    const words = trimmed.split(/\s+/).filter(Boolean);
    let currentLine = '';
    let currentWidth = 0;
    let currentLimit = isVeryFirstLine ? safeFirst : safeMax;
    const pushFinishedLine = (lineStr: string) => {
      result.push(lineStr);
      isVeryFirstLine = false;
      currentLimit = safeMax;
    };
    for (const word of words) {
      const wordW = stringWidth(word);
      if (currentLine.length === 0) {
        if (wordW <= currentLimit) {
          currentLine = word;
          currentWidth = wordW;
        } else {
          const pieces = splitLongWordByWidth(word, currentLimit);
          for (let i = 0; i < pieces.length - 1; i++) {
            pushFinishedLine(pieces[i]!);
          }
          const lastPiece = pieces[pieces.length - 1] ?? '';
          if (stringWidth(lastPiece) > currentLimit) {
            const reSplit = splitLongWordByWidth(lastPiece, currentLimit);
            for (let i = 0; i < reSplit.length - 1; i++) {
              pushFinishedLine(reSplit[i]!);
            }
            currentLine = reSplit[reSplit.length - 1] ?? '';
            currentWidth = stringWidth(currentLine);
          } else {
            currentLine = lastPiece;
            currentWidth = stringWidth(lastPiece);
          }
        }
      } else if (currentWidth + 1 + wordW <= currentLimit) {
        currentLine += ` ${word}`;
        currentWidth += 1 + wordW;
      } else {
        pushFinishedLine(currentLine);
        if (wordW <= currentLimit) {
          currentLine = word;
          currentWidth = wordW;
        } else {
          const pieces = splitLongWordByWidth(word, currentLimit);
          for (let i = 0; i < pieces.length - 1; i++) {
            pushFinishedLine(pieces[i]!);
          }
          currentLine = pieces[pieces.length - 1] ?? '';
          currentWidth = stringWidth(currentLine);
        }
      }
    }
    if (currentLine.length > 0) {
      pushFinishedLine(currentLine);
    }
  }
  return result.length > 0 ? result : [''];
}
export function truncateTextWithEllipsis(
  text: string,
  maxWidth: number,
): string {
  const limit = Math.max(1, maxWidth);
  const singleLine = text.replace(/[\r\n]+/g, ' ').trim();
  if (stringWidth(singleLine) <= limit) {
    return singleLine;
  }
  if (limit <= 3) {
    return '.'.repeat(limit);
  }
  const targetW = limit - 3;
  let acc = '';
  let accW = 0;
  for (const ch of singleLine) {
    const chW = Math.max(0, stringWidth(ch));
    if (accW + chW > targetW) {
      break;
    }
    acc += ch;
    accW += chW;
  }
  return `${acc.trimEnd()}...`;
}
export function formatThoughtPreviewLines(
  thoughtText: string,
  innerBoxWidth: number,
  maxLines = 5,
): string[] {
  const limitWidth = Math.max(10, innerBoxWidth);
  const wrapped = wrapTextByWords(thoughtText.trim(), limitWidth).filter(
    (line) => line.trim().length > 0,
  );
  if (wrapped.length === 0) {
    return [];
  }
  if (wrapped.length <= maxLines) {
    return wrapped;
  }
  const visible = wrapped.slice(0, maxLines);
  const lastIdx = visible.length - 1;
  const lastLine = (visible[lastIdx] ?? '').replace(/\.+$/, '');
  if (stringWidth(`${lastLine}...`) <= limitWidth) {
    visible[lastIdx] = `${lastLine}...`;
  } else {
    visible[lastIdx] = truncateTextWithEllipsis(`${lastLine}...`, limitWidth);
  }
  return visible;
}
function splitPlainTextWithHttpLinks(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  const urlRegex = /(https?:\/\/[^\s"'<>)\]]+)/gi;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRegex.exec(text)) !== null) {
    const rawUrl = m[1] ?? '';
    // Limpiar signos de puntuación finales sueltos (.,;:)
    const cleanUrl = rawUrl.replace(/[.,;:!?]+$/, '');
    const trailing = rawUrl.slice(cleanUrl.length);
    if (m.index > lastIdx) {
      out.push({ kind: 'text', content: text.slice(lastIdx, m.index) });
    }
    if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
      out.push({ kind: 'link', content: cleanUrl, url: cleanUrl });
      if (trailing) {
        out.push({ kind: 'text', content: trailing });
      }
    } else {
      out.push({ kind: 'text', content: rawUrl });
    }
    lastIdx = urlRegex.lastIndex;
  }
  if (lastIdx < text.length) {
    out.push({ kind: 'text', content: text.slice(lastIdx) });
  }
  return out;
}

export function buildLineLinkMap(
  lines: readonly string[],
): Map<number, RenderedLineLinkSpan[]> {
  const map = new Map<number, RenderedLineLinkSpan[]>();
  const urlRegex = /(https?:\/\/[^\s"'<>)\]]+)/gi;

  lines.forEach((line, lineIdx) => {
    const spans: RenderedLineLinkSpan[] = [];
    let m: RegExpExecArray | null;
    urlRegex.lastIndex = 0;
    while ((m = urlRegex.exec(line)) !== null) {
      const rawUrl = m[1] ?? '';
      const cleanUrl = rawUrl.replace(/[.,;:!?]+$/, '');
      if (
        !cleanUrl.toLowerCase().startsWith('http://') &&
        !cleanUrl.toLowerCase().startsWith('https://')
      ) {
        continue;
      }
      const prefix = line.slice(0, m.index);
      const startCol = stringWidth(prefix) + 1;
      const endCol = startCol + stringWidth(cleanUrl) - 1;
      spans.push({ url: cleanUrl, startCol, endCol });
    }
    if (spans.length > 0) {
      map.set(lineIdx, spans);
    }
  });

  return map;
}

export function findLinkAtLineColumn(
  linkMap: ReadonlyMap<number, readonly RenderedLineLinkSpan[]>,
  lineIndexZeroBased: number,
  colOneBased?: number,
): string | null {
  const spans = linkMap.get(lineIndexZeroBased);
  if (!spans || spans.length === 0) return null;
  if (colOneBased !== undefined) {
    for (const sp of spans) {
      if (colOneBased >= sp.startCol && colOneBased <= sp.endCol) {
        return sp.url;
      }
    }
  }
  return spans.length === 1 ? spans[0]!.url : null;
}

export function parseInlineMarkdownTokens(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const regex =
    /(\[clipboard-[^\]]+\]|\[[^\[\]\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp)\])|\[([a-z]+):\s*([^\]]+)\]|<([a-z]+)>([\s\S]*?)<\/\4>|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(
        ...splitPlainTextWithHttpLinks(line.slice(lastIndex, match.index)),
      );
    }
    const clipboardTag = match[1];
    const bracketColor = match[2]?.toLowerCase();
    const bracketContent = match[3];
    const xmlColor = match[4]?.toLowerCase();
    const xmlContent = match[5];
    const codeContent = match[6];
    const boldContent = match[7];
    const italicContent = match[8];
    if (clipboardTag !== undefined) {
      tokens.push({
        kind: 'bold',
        content: clipboardTag,
      });
    } else if (
      bracketColor &&
      bracketContent !== undefined &&
      VALID_COLORS.has(bracketColor)
    ) {
      tokens.push({
        kind: 'color',
        color: bracketColor as InlineColorName,
        content: bracketContent,
      });
    } else if (
      xmlColor &&
      xmlContent !== undefined &&
      VALID_COLORS.has(xmlColor)
    ) {
      tokens.push({
        kind: 'color',
        color: xmlColor as InlineColorName,
        content: xmlContent,
      });
    } else if (codeContent !== undefined) {
      tokens.push({
        kind: 'code',
        content: codeContent,
      });
    } else if (boldContent !== undefined) {
      tokens.push({
        kind: 'bold',
        content: boldContent,
      });
    } else if (italicContent !== undefined) {
      tokens.push({
        kind: 'italic',
        content: italicContent,
      });
    } else {
      tokens.push(...splitPlainTextWithHttpLinks(match[0]));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < line.length) {
    tokens.push(...splitPlainTextWithHttpLinks(line.slice(lastIndex)));
  }
  return tokens;
}
export function pickCodeSpanColor(
  code: string,
): 'magentaBright' | 'cyan' | 'yellow' | 'green' {
  const trimmed = code.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('--')) {
    return 'magentaBright';
  }
  if (
    trimmed.includes(String.fromCharCode(92)) ||
    trimmed.includes('/') ||
    /\.[a-z0-9]{1,5}$/i.test(trimmed)
  ) {
    return 'cyan';
  }
  if (/^\d+(\.\d+)?%?$/.test(trimmed) || trimmed.startsWith('~')) {
    return 'green';
  }
  return 'magentaBright';
}
