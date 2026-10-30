import React from 'react';
import { Box, Text } from 'ink';
import { isUnchangedNoticeText } from '../config/settings.js';
import { truncateTextWithEllipsis } from './markdownRender.js';

export interface ToolCallViewProps {
  rawText: string;
  uniformBoxWidth: number;
  uniformBoxInnerWidth: number;
  toolStatus?: 'en vivo' | 'listo' | 'error' | 'cancelado';
}

export const ToolCallView: React.FC<ToolCallViewProps> = ({
  rawText,
  uniformBoxWidth,
  toolStatus,
}) => {
  if (isUnchangedNoticeText(rawText)) {
    return (
      <Box marginLeft={0} marginTop={0} marginBottom={0} paddingX={1}>
        <Text color="gray" dimColor>
          {truncateTextWithEllipsis(rawText.trim(), uniformBoxWidth)}
        </Text>
      </Box>
    );
  }

  if (toolStatus) {
    const statusColor =
      toolStatus === 'en vivo'
        ? 'green'
        : toolStatus === 'error'
          ? 'red'
          : toolStatus === 'cancelado'
            ? 'yellow'
            : 'cyan';
    return (
      <Box marginLeft={0} marginTop={0} marginBottom={0} paddingX={1}>
        <Text color={statusColor}>
          {truncateTextWithEllipsis(rawText.trim(), uniformBoxWidth)}
        </Text>
      </Box>
    );
  }

  const rawLines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const displayLines =
    rawLines.length > 0
      ? rawLines.map((l) => truncateTextWithEllipsis(l, uniformBoxWidth))
      : [truncateTextWithEllipsis(rawText, uniformBoxWidth)];

  return (
    <Box
      flexDirection="column"
      width={uniformBoxWidth}
      marginLeft={0}
      paddingX={1}
      marginTop={0}
      marginBottom={0}
    >
      {displayLines.map((ln, idx) => (
        <Text key={idx} color="gray">
          {ln}
        </Text>
      ))}
    </Box>
  );
};
