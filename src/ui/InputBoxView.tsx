import React from 'react';
import { Box, Text } from 'ink';
import type { SlashCommandEntry } from '../commands/slashRegistry.js';
import {
  DEFAULT_INPUT_PLACEHOLDER_ES,
  formatInputPlaceholder,
  formatQueueItemDisplayLine,
} from '../core/lineEditor.js';

export interface VisualInputLine {
  text: string;
  start: number;
  end: number;
}

export function wrapInputTextIntoVisualLines(
  text: string,
  lineWidth: number,
): VisualInputLine[] {
  const safeWidth = Math.max(10, lineWidth);
  const result: VisualInputLine[] = [];
  const hardLines = text.split('\n');
  let offset = 0;

  for (let h = 0; h < hardLines.length; h++) {
    const hard = hardLines[h]!;
    if (hard.length === 0) {
      result.push({ text: '', start: offset, end: offset });
      offset += 1;
      continue;
    }
    let pos = 0;
    while (pos < hard.length) {
      const remaining = hard.length - pos;
      if (remaining <= safeWidth) {
        result.push({
          text: hard.slice(pos),
          start: offset + pos,
          end: offset + hard.length,
        });
        pos = hard.length;
        break;
      }
      let breakAt = pos + safeWidth;
      const lastSpace = hard.lastIndexOf(' ', breakAt);
      if (lastSpace > pos + Math.floor(safeWidth * 0.35)) {
        breakAt = lastSpace + 1;
      }
      result.push({
        text: hard.slice(pos, breakAt),
        start: offset + pos,
        end: offset + breakAt,
      });
      pos = breakAt;
    }
    offset += hard.length + 1;
  }

  return result.length > 0 ? result : [{ text: '', start: 0, end: 0 }];
}

function renderSegmentWithClipboardBold(segment: string): React.ReactNode {
  if (!segment) return null;
  const parts = segment.split(
    /(\[clipboard-[^\]]+\]|\[[^\[\]\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp)\])/gi,
  );
  return parts.map((part, idx) => {
    if (!part) return null;
    if (
      /^\[(?:clipboard-[^\]]+|[^\[\]\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp))\]$/i.test(
        part,
      )
    ) {
      return (
        <Text key={idx} bold color="whiteBright">
          {part}
        </Text>
      );
    }
    return (
      <Text key={idx} color="white">
        {part}
      </Text>
    );
  });
}

export interface InputBoxViewProps {
  inputText: string;
  inputCursor: number;
  columns: number;
  maxInputBoxLines: number;
  userTurnCounter: number;
  editingQueueIdx: number | null;
  confirmDeleteQueueIdx: number | null;
  ctrlCPending: boolean;
  queuedPrompts: readonly string[];
  matchingSlash: readonly SlashCommandEntry[];
  suggestionIdx: number;
}

export const InputBoxView: React.FC<InputBoxViewProps> = ({
  inputText,
  inputCursor,
  columns,
  maxInputBoxLines,
  editingQueueIdx,
  confirmDeleteQueueIdx,
  ctrlCPending,
  queuedPrompts,
  matchingSlash,
  suggestionIdx,
}) => {
  const promptPrefixStr =
    editingQueueIdx !== null ? `[Cola #${editingQueueIdx + 1}] > ` : '> ';
  const indentPrefixStr = ' '.repeat(promptPrefixStr.length);
  const fittedPlaceholder = formatInputPlaceholder(
    DEFAULT_INPUT_PLACEHOLDER_ES,
    columns,
    promptPrefixStr.length,
  );

  const textLineWidth = Math.max(12, columns - promptPrefixStr.length - 8);
  const visualLines = wrapInputTextIntoVisualLines(inputText, textLineWidth);
  const safeCursor = Math.max(0, Math.min(inputCursor, inputText.length));

  let cursorVisualIdx = visualLines.length - 1;
  for (let i = 0; i < visualLines.length; i++) {
    const vl = visualLines[i]!;
    const isLast = i === visualLines.length - 1;
    if (
      safeCursor >= vl.start &&
      (safeCursor < vl.end || (isLast && safeCursor <= vl.end))
    ) {
      cursorVisualIdx = i;
      break;
    }
  }

  const effectiveMaxLines = Math.max(2, Math.min(6, maxInputBoxLines));
  const scrollStart =
    visualLines.length <= effectiveMaxLines
      ? 0
      : Math.max(
          0,
          Math.min(
            visualLines.length - effectiveMaxLines,
            cursorVisualIdx - effectiveMaxLines + 1,
          ),
        );
  const visibleLines = visualLines.slice(
    scrollStart,
    scrollStart + effectiveMaxLines,
  );

  return (
    <Box flexDirection="column">
      {confirmDeleteQueueIdx !== null && (
        <Box paddingX={1} marginBottom={0}>
          <Text color="red" bold>
            {`¿Borrar posición #${confirmDeleteQueueIdx + 1} de la fila? [Enter/S borrar · Esc/N cancelar]`}
          </Text>
        </Box>
      )}

      {ctrlCPending && (
        <Box paddingX={1} marginBottom={0}>
          <Text color="yellow" bold>
            {'Presiona otra vez para salir'}
          </Text>
        </Box>
      )}

      {queuedPrompts.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text color="gray" dimColor>
            {`En fila (${queuedPrompts.length}):`}
          </Text>
          {queuedPrompts.map((qp, idx) => {
            const isEditingThis = editingQueueIdx === idx;
            const displayLine = formatQueueItemDisplayLine(
              qp,
              idx + 1,
              isEditingThis,
              columns,
            );
            return (
              <Text
                key={idx}
                color={isEditingThis ? 'cyan' : 'gray'}
                bold={isEditingThis}
                wrap="truncate-end"
              >
                {displayLine}
              </Text>
            );
          })}
        </Box>
      )}

      {matchingSlash.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          {matchingSlash.map((item, idx) => (
            <Box key={item.cmd} flexDirection="row">
              <Text color={idx === suggestionIdx ? 'cyan' : 'white'} bold>
                {idx === suggestionIdx ? '> ' : '  '}
                {item.displayCmd.padEnd(14, ' ')}
              </Text>
              <Text color="gray" dimColor>
                {item.desc}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        flexDirection="column"
      >
        {inputText.length > 0 ? (
          <Box flexDirection="column">
            {visibleLines.map((vl, idx) => {
              const absIdx = scrollStart + idx;
              const isCursorLine = absIdx === cursorVisualIdx;
              const prefixNode =
                absIdx === 0 ? (
                  <Text color="cyan" bold>
                    {promptPrefixStr}
                  </Text>
                ) : (
                  <Text color="gray" dimColor>
                    {indentPrefixStr}
                  </Text>
                );

              if (!isCursorLine) {
                return (
                  <Text key={absIdx}>
                    {prefixNode}
                    {renderSegmentWithClipboardBold(vl.text)}
                  </Text>
                );
              }

              const relCursor = Math.max(0, safeCursor - vl.start);
              const before = vl.text.slice(0, relCursor);
              const cursorChar =
                relCursor < vl.text.length ? vl.text[relCursor]! : ' ';
              const after =
                relCursor < vl.text.length ? vl.text.slice(relCursor + 1) : '';

              return (
                <Text key={absIdx}>
                  {prefixNode}
                  {renderSegmentWithClipboardBold(before)}
                  <Text inverse bold>
                    {cursorChar}
                  </Text>
                  {renderSegmentWithClipboardBold(after)}
                </Text>
              );
            })}
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text color="cyan" bold>
              {promptPrefixStr}
            </Text>
            <Text color="gray" dimColor wrap="truncate-end">
              {fittedPlaceholder}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
