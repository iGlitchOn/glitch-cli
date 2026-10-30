import React from 'react';
import { Box, Text } from 'ink';
import type { GlitchSettings } from '../config/settings.js';
import { formatElapsedDuration } from '../core/errorFormat.js';
import type { LiveSubagentInfo } from '../core/subagents.js';
import {
  formatInputTopLeftWithTotal,
  formatStatusBar,
  formatTelemetryStatusBarLine,
  formatThinkingStatusLine,
} from './statusBar.js';

export interface StatusBarTopProps {
  settings: GlitchSettings;
  columns: number;
  isStreaming: boolean;
  isCompactingContext: boolean;
  streamingElapsedMs: number;
  currentTurnCostUsd: number | null;
  totalChatCostUsd: number | null;
  unknownPriceRequestCount?: number;
  mcpCount: number;
  skillCount: number;
  maxContextTokens: number;
  totalUsedTokens: number;
  runningSubagents: readonly LiveSubagentInfo[];
  selectionMode?: boolean;
  thoughtsCollapsed?: boolean | null;
  transientStatusNotice?: string;
}

export const StatusBarTop: React.FC<StatusBarTopProps> = React.memo(({
  settings,
  columns,
  isStreaming,
  isCompactingContext,
  streamingElapsedMs,
  totalChatCostUsd,
  unknownPriceRequestCount = 0,
  mcpCount,
  skillCount,
  maxContextTokens,
  totalUsedTokens,
  selectionMode = false,
  thoughtsCollapsed = null,
  transientStatusNotice = '',
}) => {
  const telemetryText = formatTelemetryStatusBarLine({
    usedTokens: totalUsedTokens,
    maxTokens: maxContextTokens,
    activeMcpCount: mcpCount,
    activeSkillCount: skillCount,
    costUsd: totalChatCostUsd,
    unknownPriceCount: unknownPriceRequestCount,
  });

  const isCollapsedGlobal =
    typeof thoughtsCollapsed === 'boolean'
      ? thoughtsCollapsed
      : (settings.thinkingDisplay ?? 'expandido') === 'contraido';
  const thoughtToggleBtn = isCollapsedGlobal
    ? 'expandir pensamiento'
    : 'plegar pensamiento';

  const rightSideText = selectionMode
    ? 'seleccion: ctrl+s para volver'
    : transientStatusNotice
      ? transientStatusNotice
      : isCompactingContext
        ? 'Compactando contexto...'
        : isStreaming
          ? formatThinkingStatusLine(formatElapsedDuration(streamingElapsedMs))
          : `[${thoughtToggleBtn}]`;

  const leftStatusText = formatInputTopLeftWithTotal(
    settings,
    totalChatCostUsd,
    telemetryText,
    columns,
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="flex-end" paddingX={1}>
        <Text color="gray">{telemetryText}</Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text
          color={
            selectionMode || isCompactingContext
              ? 'yellow'
              : isStreaming || transientStatusNotice
                ? 'cyan'
                : 'gray'
          }
          dimColor={!isStreaming && !selectionMode && !isCompactingContext && !transientStatusNotice}
        >
          {rightSideText}
        </Text>
        <Text color="white">{leftStatusText}</Text>
      </Box>
    </Box>
  );
});

export interface StatusBarBottomProps {
  settings: GlitchSettings;
  activeAgentCount: number;
  isCompactingContext: boolean;
}

export const StatusBarBottom: React.FC<StatusBarBottomProps> = React.memo(({
  settings,
  activeAgentCount,
  isCompactingContext,
}) => {
  const isFullscreenTui = settings.tuiMode === 'fullscreen';
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
      marginTop={0}
    >
      {isFullscreenTui ? (
        <Text color="cyan">
          {`[Agentes (${activeAgentCount})]  [Atajos (?)]`}
          <Text color="gray" dimColor>{'  . Salir: Ctrl+C'}</Text>
        </Text>
      ) : (
        <Text color="gray" dimColor>
          {`Agentes (${activeAgentCount}) . ? = atajos . Salir: Ctrl+C`}
        </Text>
      )}
      <Text color={isCompactingContext ? 'yellow' : 'cyan'}>
        {isCompactingContext
          ? 'Compactando contexto...'
          : isFullscreenTui
            ? `[${formatStatusBar(settings)}]`
            : formatStatusBar(settings)}
      </Text>
    </Box>
  );
});
