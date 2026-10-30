import React from 'react';
import { Box, Text } from 'ink';
import { formatElapsedDuration } from '../core/errorFormat.js';
import type { LiveSubagentInfo } from '../core/subagents.js';
import { truncateTextWithEllipsis } from './markdownRender.js';

export function formatSubagentStateLabel(
  status: LiveSubagentInfo['status'] | 'limit',
): string {
  if (status === 'running') return 'en vivo';
  if (status === 'completed') return 'listo';
  if (status === 'limite' || status === 'limit') return 'limite';
  if (status === 'cancelled') return 'cancelado';
  return 'error';
}

export function getSubagentStateColor(
  status: LiveSubagentInfo['status'] | 'limit',
): 'green' | 'cyan' | 'yellow' | 'red' | 'gray' {
  if (status === 'running') return 'green';
  if (status === 'completed') return 'cyan';
  if (status === 'limite' || status === 'limit') return 'yellow';
  if (status === 'cancelled') return 'gray';
  return 'red';
}

export function resolveSubagentZeroBasedIndex(
  sub: LiveSubagentInfo,
  fallbackIdx = 0,
): number {
  if (typeof sub.agentIndex === 'number' && sub.agentIndex >= 0) {
    return sub.agentIndex;
  }
  const numMatch = sub.id.match(/(\d+)$/);
  if (numMatch?.[1]) {
    return Math.max(0, Number.parseInt(numMatch[1], 10) - 1);
  }
  return fallbackIdx;
}

export function formatSubagentBriefOriginLabel(
  sub: LiveSubagentInfo,
  fallbackIdx = 0,
): string {
  const num = resolveSubagentZeroBasedIndex(sub, fallbackIdx);
  const chatPart = sub.originChatTitle?.trim();
  const namePart = sub.name.trim();
  const desc =
    chatPart && !namePart.toLowerCase().includes(chatPart.toLowerCase())
      ? `${chatPart} (${namePart})`
      : namePart || chatPart || 'Subagente';
  return `Agente #${num} - ${desc}`;
}

export interface SubagentsViewProps {
  subagents: readonly LiveSubagentInfo[];
  maxItems?: number;
  nowMs?: number;
}

export const SubagentsView: React.FC<SubagentsViewProps> = ({
  subagents,
  maxItems = 8,
  nowMs = Date.now(),
}) => {
  const runningSubs = subagents.filter((s) => s.status === 'running');
  if (runningSubs.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={1} marginTop={0} marginBottom={1}>
      <Text color="cyan" bold>
        {`Agentes  ${runningSubs.length} en vivo`}
      </Text>
      {runningSubs.slice(-maxItems).map((sub, idx) => {
        const stateLabel = formatSubagentStateLabel(sub.status);
        const stateColor = getSubagentStateColor(sub.status);
        const endTs = sub.finishedAt ?? nowMs;
        const elapsedStr = formatElapsedDuration(
          Math.max(0, endTs - sub.startedAt),
        );
        const briefLabel = formatSubagentBriefOriginLabel(sub, idx);

        return (
          <Box key={sub.id} flexDirection="row">
            <Text color="white">
              {`${truncateTextWithEllipsis(briefLabel, 54).padEnd(54, ' ')}  `}
            </Text>
            <Text color="gray">{`${elapsedStr.padStart(7, ' ')}  `}</Text>
            <Text color={stateColor}>{stateLabel}</Text>
          </Box>
        );
      })}
    </Box>
  );
};
