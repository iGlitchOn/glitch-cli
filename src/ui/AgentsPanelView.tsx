import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { Content } from '@google/genai';
import type { GlitchSettings } from '../config/settings.js';
import { formatElapsedDuration, formatMessageTimestamp } from '../core/errorFormat.js';
import {
  cleanSessionTitle,
  countRealUserTurns,
  deriveSessionTitle,
  formatRelativeSessionDate,
  type SavedSession,
  type SavedUiMessage,
} from '../core/sessionStore.js';
import type { LiveSubagentInfo } from '../core/subagents.js';
import {
  formatSubagentBriefOriginLabel,
  formatSubagentStateLabel,
  getSubagentStateColor,
} from './SubagentsView.js';

export interface ActiveTerminalChatEntry {
  id: string;
  title: string;
  turnCount: number;
  isStreaming: boolean;
  isCurrent: boolean;
  model: string;
}

export function truncateAndPadColumn(text: string, width: number): string {
  const safeW = Math.max(4, width);
  const single = text.replace(/[\r\n]+/g, ' ').trim();
  const curW = stringWidth(single);
  if (curW <= safeW) {
    return single + ' '.repeat(Math.max(0, safeW - curW));
  }
  const targetW = safeW - 1;
  let acc = '';
  let accW = 0;
  for (const ch of single) {
    const chW = Math.max(0, stringWidth(ch));
    if (accW + chW > targetW) break;
    acc += ch;
    accW += chW;
  }
  const truncated = `${acc.trimEnd()}…`;
  const truncW = stringWidth(truncated);
  return truncated + ' '.repeat(Math.max(0, safeW - truncW));
}

export interface AgentsTableColumnWidths {
  nameWidth: number;
  stepWidth: number;
  stateWidth: number;
  actionWidth: number;
  timeWidth: number;
}

export function computeAgentsTableColumnWidths(
  terminalColumns: number,
): AgentsTableColumnWidths {
  const usable = Math.max(54, terminalColumns - 8);
  const stepWidth = 9;
  const stateWidth = 10;
  const timeWidth = 7;
  const fixed = stepWidth + stateWidth + timeWidth + 8;
  const remaining = Math.max(24, usable - fixed);
  const nameWidth = Math.max(14, Math.floor(remaining * 0.52));
  const actionWidth = Math.max(14, remaining - nameWidth);
  return {
    nameWidth,
    stepWidth,
    stateWidth,
    actionWidth,
    timeWidth,
  };
}

export function groupSubagentsByRound(
  subagents: readonly LiveSubagentInfo[],
): Array<{ round: number; items: LiveSubagentInfo[] }> {
  const map = new Map<number, LiveSubagentInfo[]>();
  for (const sub of subagents) {
    const r = sub.round ?? 1;
    const list = map.get(r) ?? [];
    list.push(sub);
    map.set(r, list);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([round, items]) => ({ round, items }));
}

export function getVisibleSubagentsForPanel(
  subagents: readonly LiveSubagentInfo[],
  showAllAgentsHistory: boolean,
): LiveSubagentInfo[] {
  const sorted = [...subagents].sort((a, b) => a.startedAt - b.startedAt);
  if (showAllAgentsHistory) {
    return sorted;
  }
  return sorted.filter((s) => s.status === 'running');
}

export interface FilteredHistorySessionsResult {
  visibleSessions: SavedSession[];
  hiddenShortCount: number;
  showToggleAllOption: boolean;
  hasMultipleModels: boolean;
}

export function filterSavedSessionsForPanel(
  allSessions: readonly SavedSession[],
  currentSessionId: string,
  showAllSessions: boolean,
  maxVisible = 8,
  excludeActiveIds: ReadonlySet<string> = new Set(),
): FilteredHistorySessionsResult {
  const pool = allSessions.filter((s) => !excludeActiveIds.has(s.id));
  const longSessions: SavedSession[] = [];
  let hiddenShortCount = 0;

  for (const s of pool) {
    const turns = countRealUserTurns(s);
    if (turns > 2 || s.id === currentSessionId) {
      longSessions.push(s);
    } else {
      hiddenShortCount += 1;
    }
  }

  const baseList = showAllSessions ? [...pool] : longSessions;
  const visibleSessions = baseList.slice(0, maxVisible);
  const extraTrimmed = Math.max(0, pool.length - visibleSessions.length);
  const showToggleAllOption = hiddenShortCount > 0 || extraTrimmed > 0;
  const distinctModels = new Set(visibleSessions.map((s) => s.model));

  return {
    visibleSessions,
    hiddenShortCount:
      hiddenShortCount +
      (showAllSessions ? 0 : Math.max(0, longSessions.length - maxVisible)),
    showToggleAllOption,
    hasMultipleModels: distinctModels.size > 1,
  };
}

export interface AgentsPanelViewProps {
  settings: GlitchSettings;
  sessionId: string;
  messages: readonly SavedUiMessage[];
  history: readonly Content[];
  isStreaming: boolean;
  dialogCursor: number;
  liveSubagents: readonly LiveSubagentInfo[];
  savedSessionsList: readonly SavedSession[];
  activeChats?: readonly ActiveTerminalChatEntry[];
  columns?: number;
  selectedSubagentId?: string | null;
  correctionInputText?: string;
  pendingRelaunchConfirm?: boolean;
  showAllHistorySessions?: boolean;
  showAllAgentsHistory?: boolean;
  statusNotice?: string;
}

export const AgentsPanelView: React.FC<AgentsPanelViewProps> = ({
  settings,
  sessionId,
  messages,
  history,
  isStreaming,
  dialogCursor,
  liveSubagents,
  savedSessionsList,
  activeChats,
  columns = process.stdout.columns ?? 100,
  selectedSubagentId = null,
  correctionInputText = '',
  pendingRelaunchConfirm = false,
  showAllHistorySessions = false,
  showAllAgentsHistory = false,
  statusNotice = '',
}) => {
  const nowMs = Date.now();
  const runningCount = liveSubagents.filter((s) => s.status === 'running').length;
  const totalSubCount = liveSubagents.length;

  const selectedSub = selectedSubagentId
    ? liveSubagents.find((s) => s.id === selectedSubagentId)
    : undefined;

  if (selectedSub) {
    const stateLabel = formatSubagentStateLabel(selectedSub.status);
    const stateColor = getSubagentStateColor(selectedSub.status);
    const endTs = selectedSub.finishedAt ?? nowMs;
    const elapsed = formatElapsedDuration(
      Math.max(0, endTs - selectedSub.startedAt),
    );
    const recentLogs = (selectedSub.log ?? []).slice(-10);
    const isFinished = selectedSub.status !== 'running';
    const briefLabel = formatSubagentBriefOriginLabel(selectedSub, 0);

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text bold color="cyan">
            {`AGENTES  >  ${briefLabel} (${elapsed})`}
          </Text>
          <Text color={stateColor} bold>
            {stateLabel}
          </Text>
        </Box>

        <Text color="gray">{'Tarea:'}</Text>
        <Text color="white">{`  ${selectedSub.task}`}</Text>

        <Box marginTop={1} flexDirection="column">
          <Text color="gray">{'Log en vivo:'}</Text>
          {recentLogs.length === 0 ? (
            <Text color="gray" dimColor>
              {'  (Sin eventos registrados todavía)'}
            </Text>
          ) : (
            recentLogs.map((ev, idx) => (
              <Text
                key={idx}
                color={
                  ev.kind === 'block_summary'
                    ? 'cyan'
                    : ev.kind === 'correction'
                      ? 'yellow'
                      : 'gray'
                }
                dimColor={ev.kind === 'subthinking'}
              >
                {`  ${truncateAndPadColumn(ev.text, Math.max(30, columns - 8)).trimEnd()}`}
              </Text>
            ))
          )}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color="gray">{'Resultado:'}</Text>
          <Text color="white">
            {`  ${truncateAndPadColumn(selectedSub.fullOutput || selectedSub.resultPreview || '(en ejecución)', Math.max(30, columns - 8)).trimEnd()}`}
          </Text>
        </Box>

        {isFinished && pendingRelaunchConfirm && (
          <Box marginTop={1}>
            <Text color="yellow">
              {`El subagente está en estado "${stateLabel}". Presiona Enter de nuevo para relanzarlo con esta corrección o Esc para cancelar.`}
            </Text>
          </Box>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">
            {`> Corrección: ${correctionInputText}`}
            <Text inverse bold>
              {' '}
            </Text>
          </Text>
          <Text color="gray" dimColor>
            {'enter enviar corrección  c continuar  x cancelar  esc volver'}
          </Text>
        </Box>
      </Box>
    );
  }

  const visibleSubagents = getVisibleSubagentsForPanel(
    liveSubagents,
    showAllAgentsHistory,
  );

  const currentTurnCount = countRealUserTurns({
    history: [...history],
    messages: [...messages],
  });
  const currentTitle = cleanSessionTitle(
    deriveSessionTitle([...messages], [...history]),
  );

  const effectiveActiveChats: ActiveTerminalChatEntry[] =
    activeChats && activeChats.length > 0
      ? [...activeChats]
      : [
          {
            id: sessionId,
            title: currentTitle,
            turnCount: currentTurnCount,
            isStreaming,
            isCurrent: true,
            model: settings.model,
          },
        ];

  const activeChatIds = new Set(effectiveActiveChats.map((c) => c.id));
  const filteredHistory = filterSavedSessionsForPanel(
    savedSessionsList,
    sessionId,
    showAllHistorySessions,
    6,
    activeChatIds,
  );

  // Cursor layout:
  // 0 -> AGENTES ▼ (toggle historial de agentes)
  // 1 .. visibleSubagents.length -> agentes visibles
  // next .. +effectiveActiveChats.length -> chats activos
  // next -> + Nuevo chat activo
  // next .. +filteredHistory.visibleSessions.length -> historial
  // last -> ver todas (si aplica)
  const isHeaderSelected = dialogCursor === 0;
  const arrowSymbol = showAllAgentsHistory ? '▲' : '▼';
  const titleWidth = Math.max(24, Math.floor((columns - 34) * 0.6));

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={isHeaderSelected ? 'cyan' : 'white'} bold>
          {isHeaderSelected ? '> ' : '  '}
          {`AGENTES ${arrowSymbol}`}
          <Text color="gray" dimColor>
            {showAllAgentsHistory
              ? `  (mostrando historial completo: ${totalSubCount} agentes · enter para solo vivos)`
              : `  (${runningCount} en vivo · enter para ver historial de ${totalSubCount} agentes)`}
          </Text>
        </Text>
      </Box>

      {visibleSubagents.length === 0 ? (
        <Text color="gray" dimColor>
          {showAllAgentsHistory
            ? '    Sin agentes registrados en esta sesión de terminal'
            : '    Sin agentes vivos actualmente'}
        </Text>
      ) : (
        visibleSubagents.map((sub, idx) => {
          const rowIdx = 1 + idx;
          const isSelected = dialogCursor === rowIdx;
          const stateLabel = formatSubagentStateLabel(sub.status);
          const stateColor = getSubagentStateColor(sub.status);
          const endTs = sub.finishedAt ?? nowMs;
          const elapsed = formatElapsedDuration(
            Math.max(0, endTs - sub.startedAt),
          );
          const briefOrigin = formatSubagentBriefOriginLabel(sub, idx);
          const startedDateStr = formatMessageTimestamp(new Date(sub.startedAt));

          return (
            <Box key={sub.id} flexDirection="row">
              <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                {isSelected ? '> ' : '  '}
                {truncateAndPadColumn(briefOrigin, Math.max(28, titleWidth))}
                {'  '}
              </Text>
              {showAllAgentsHistory && (
                <Text color="gray">
                  {`${startedDateStr.padEnd(20, ' ')}  `}
                </Text>
              )}
              <Text color="gray">{`${elapsed.padStart(7, ' ')}  `}</Text>
              <Text color={stateColor} bold={sub.status === 'limite'}>
                {stateLabel}
              </Text>
            </Box>
          );
        })
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>
          {'Chats activos'}
        </Text>
        {effectiveActiveChats.map((chat, cIdx) => {
          const rowIdx = 1 + visibleSubagents.length + cIdx;
          const isSelected = dialogCursor === rowIdx;
          const stateStr = chat.isStreaming
            ? 'en vivo'
            : chat.isCurrent
              ? 'actual'
              : 'activo';
          return (
            <Text
              key={chat.id}
              color={isSelected ? 'cyan' : chat.isCurrent ? 'whiteBright' : 'white'}
              bold={isSelected || chat.isCurrent}
            >
              {isSelected ? '> ' : '  '}
              {truncateAndPadColumn(cleanSessionTitle(chat.title), titleWidth)}
              {'  '}
              {truncateAndPadColumn(stateStr, 10)}
              {'  '}
              {`${chat.turnCount} ${chat.turnCount === 1 ? 'turno' : 'turnos'}`}
            </Text>
          );
        })}
        {(() => {
          const newChatRowIdx =
            1 + visibleSubagents.length + effectiveActiveChats.length;
          const isNewSel = dialogCursor === newChatRowIdx;
          return (
            <Text color={isNewSel ? 'cyan' : 'green'} bold={isNewSel}>
              {isNewSel ? '> ' : '  '}
              {'+ Nuevo chat activo en esta terminal'}
            </Text>
          );
        })()}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>
          {'Historial'}
        </Text>
        {filteredHistory.visibleSessions.length === 0 ? (
          <Text color="gray" dimColor>
            {'  Sin conversaciones anteriores'}
          </Text>
        ) : (
          filteredHistory.visibleSessions.map((s, idx) => {
            const rowIndex =
              1 +
              visibleSubagents.length +
              effectiveActiveChats.length +
              1 +
              idx;
            const isSelected = dialogCursor === rowIndex;
            const turns = countRealUserTurns(s);
            const relDate = formatRelativeSessionDate(s.updatedAt);
            const cleanedTitle = cleanSessionTitle(s.title);

            return (
              <Text
                key={s.id}
                color={isSelected ? 'cyan' : 'gray'}
                bold={isSelected}
              >
                {isSelected ? '> ' : '  '}
                {truncateAndPadColumn(cleanedTitle, titleWidth)}
                {'  '}
                {truncateAndPadColumn(relDate, 10)}
                {'  '}
                {`${turns} ${turns === 1 ? 'turno' : 'turnos'}`}
                {filteredHistory.hasMultipleModels ? `  ${s.model}` : ''}
              </Text>
            );
          })
        )}

        {filteredHistory.showToggleAllOption &&
          (() => {
            const toggleRowIndex =
              1 +
              visibleSubagents.length +
              effectiveActiveChats.length +
              1 +
              filteredHistory.visibleSessions.length;
            const isToggleSelected = dialogCursor === toggleRowIndex;
            const toggleText = showAllHistorySessions
              ? 'ocultar conversaciones cortas (<= 2 turnos)'
              : `ver todas (${filteredHistory.hiddenShortCount} ocultas)`;
            return (
              <Text
                color={isToggleSelected ? 'cyan' : 'gray'}
                bold={isToggleSelected}
              >
                {isToggleSelected ? '> ' : '  '}
                {toggleText}
              </Text>
            );
          })()}
      </Box>

      {statusNotice ? (
        <Box marginTop={1}>
          <Text color="yellow">{statusNotice}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {'enter abrir/alternar  c continuar  x cancelar  esc volver'}
        </Text>
      </Box>
    </Box>
  );
};
