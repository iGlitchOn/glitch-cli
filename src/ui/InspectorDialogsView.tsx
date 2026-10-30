import React from 'react';
import { Box, Text } from 'ink';
import { SLASH_COMMANDS } from '../commands/slashRegistry.js';
import {
  DEFAULT_MODEL_PRICING,
  resolveModelPricingForDate,
  type GlitchSettings,
} from '../config/settings.js';
import type { McpServerEntry } from '../core/mcpRegistry.js';
import { formatSkillTokens, type SkillInfo } from '../core/skills.js';
import {
  formatChatTotalAmount,
  formatUsdAmount,
  type ChatCostSummary,
  type ContextUsageBreakdown,
  type CostRequestRecord,
} from './statusBar.js';
import type { ActiveDialog } from './DialogsView.js';

export interface InspectorDialogsViewProps {
  activeDialog: ActiveDialog;
  settings: GlitchSettings;
  version: string;
  dialogCursor: number;
  mcpServers: readonly McpServerEntry[];
  installedSkills: readonly SkillInfo[];
  activeSkillNames: readonly string[];
  activeSkillContents: ReadonlyMap<string, string>;
  contextBreakdown: ContextUsageBreakdown;
  historyTurnCount: number;
  costRecords: readonly CostRequestRecord[];
  chatCostSummary: ChatCostSummary;
  lastTurnDurationText: string;
  showShortcutsPanel: boolean;
}

interface ModelUsageRowSummary {
  modelId: string;
  reqs: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  rateText: string;
}

function buildModelUsageTableRows(
  costRecords: readonly CostRequestRecord[],
  settings: GlitchSettings,
): ModelUsageRowSummary[] {
  const map = new Map<string, ModelUsageRowSummary>();
  const pricingTable = settings.modelPricing ?? DEFAULT_MODEL_PRICING;

  const resolveRateLabel = (modelId: string): string => {
    const rawEntry = pricingTable[modelId] ?? DEFAULT_MODEL_PRICING[modelId];
    if (!rawEntry) return 'sin tarifa';
    const eff = resolveModelPricingForDate(rawEntry);
    return `$${eff.inputPerMillion}/$${eff.cachePerMillion}/$${eff.outputPerMillion}`;
  };

  for (const rec of costRecords) {
    const existing = map.get(rec.model) ?? {
      modelId: rec.model,
      reqs: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      rateText: resolveRateLabel(rec.model),
    };
    existing.reqs += 1;
    existing.inputTokens += Math.max(0, rec.inputTokens);
    existing.cachedTokens += Math.max(0, rec.cachedTokens);
    existing.outputTokens += Math.max(0, rec.outputTokens + rec.reasoningTokens);
    if (rec.costUsd !== null && !Number.isNaN(rec.costUsd)) {
      existing.costUsd += rec.costUsd;
    }
    map.set(rec.model, existing);
  }

  if (!map.has(settings.model)) {
    map.set(settings.model, {
      modelId: settings.model,
      reqs: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      rateText: resolveRateLabel(settings.model),
    });
  }

  return Array.from(map.values());
}

export const InspectorDialogsView: React.FC<InspectorDialogsViewProps> = ({
  activeDialog,
  settings,
  version,
  dialogCursor,
  mcpServers,
  installedSkills,
  activeSkillNames,
  activeSkillContents,
  contextBreakdown,
  historyTurnCount,
  costRecords,
  chatCostSummary,
  lastTurnDurationText,
  showShortcutsPanel,
}) => {
  if (activeDialog === 'mcp') {
    const selectedMcp = mcpServers[dialogCursor] ?? mcpServers[0];
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="cyan">
            {selectedMcp
              ? `MCP: ${selectedMcp.id} (${selectedMcp.commands.length} tools)`
              : 'Sin servidores MCP detectados'}
          </Text>
          <Text color="gray" dimColor>{'cambiar MCP  esc cerrar'}</Text>
        </Box>
        {selectedMcp && (
          <>
            <Text color="gray" dimColor>{`Origen: ${selectedMcp.source} (${selectedMcp.configPath})`}</Text>
            <Text color="white">{`Comando: ${selectedMcp.commandLine}`}</Text>
            <Box flexDirection="column" marginTop={1}>
              <Text color="cyan">{'Herramientas:'}</Text>
              {selectedMcp.commands.map((cmd) => (
                <Text key={cmd.name} color="gray">
                  {`  ${cmd.name.padEnd(28, ' ')}  ${cmd.summary}`}
                </Text>
              ))}
            </Box>
          </>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" dimColor>{'─'.repeat(64)}</Text>
          {mcpServers.map((m, idx) => {
            const isSel = idx === dialogCursor;
            return (
              <Text key={m.id} color={isSel ? 'cyan' : 'white'} bold={isSel}>
                {isSel ? '> ' : '  '}
                {`${m.id.padEnd(20, ' ')}  ${m.source.padEnd(28, ' ')}  ${m.active ? 'en vivo' : 'listo'}`}
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (activeDialog === 'skills') {
    const totalTokensAll = installedSkills.reduce(
      (acc, s) => acc + s.approxTokens,
      0,
    );
    const pageSize = 10;
    const totalPages = Math.max(
      1,
      Math.ceil(installedSkills.length / pageSize),
    );
    const currentPage = Math.floor(dialogCursor / pageSize);
    const sliceStart = currentPage * pageSize;
    const visibleSkills = installedSkills.slice(
      sliceStart,
      sliceStart + pageSize,
    );
    const selectedSkill = installedSkills[dialogCursor];

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="cyan">
            {`Skills (${activeSkillNames.length} en vivo · ${installedSkills.length} en disco · ${formatSkillTokens(totalTokensAll)})`}
          </Text>
          <Text color="gray" dimColor>
            {`${currentPage + 1}/${totalPages}  elegir  enter activar  esc cerrar`}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {visibleSkills.map((sk, idx) => {
            const realIdx = sliceStart + idx;
            const isSel = realIdx === dialogCursor;
            const isActive = activeSkillContents.has(sk.name);
            return (
              <Text
                key={sk.name}
                color={isSel ? 'cyan' : isActive ? 'green' : 'white'}
                bold={isSel || isActive}
              >
                {isSel ? '> ' : '  '}
                {isActive ? 'en vivo  ' : 'listo    '}
                {sk.name.padEnd(28, ' ')}  {sk.sourceLabel.padEnd(32, ' ')}  {formatSkillTokens(sk.approxTokens)}
              </Text>
            );
          })}
        </Box>

        {selectedSkill && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray" dimColor>{'─'.repeat(72)}</Text>
            <Text bold color="cyan">
              {`${selectedSkill.name} (${formatSkillTokens(selectedSkill.approxTokens)})`}
            </Text>
            <Text color="gray" dimColor>{selectedSkill.filePath}</Text>
            <Text color="white">{selectedSkill.description}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (activeDialog === 'usage') {
    const modelRows = buildModelUsageTableRows(costRecords, settings);
    const authLabel =
      settings.provider === 'custom' ? 'custom-api' : 'vertex-ai';
    const histTokens =
      contextBreakdown.historyTextTokens +
      contextBreakdown.historyThoughtTokens +
      contextBreakdown.historyToolCallTokens;

    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text bold color="cyan">
            {'Estadísticas de Sesión (/usage)'}
          </Text>
          <Text color="gray" dimColor>{'enter o esc cerrar'}</Text>
        </Box>

        <Text bold color="white">{'Resumen de Interacción'}</Text>
        <Box flexDirection="row">
          <Text color="cyan">{'Proveedor:          '}</Text>
          <Text color="white">{authLabel}</Text>
        </Box>
        <Box flexDirection="row">
          <Text color="cyan">{'Contexto usado:     '}</Text>
          <Text color="white">
            {`${contextBreakdown.totalUsedTokens.toLocaleString('en-US')} / ${contextBreakdown.maxTokens.toLocaleString('en-US')} tok (${contextBreakdown.usedPercent}%)`}
          </Text>
        </Box>
        <Box flexDirection="row">
          <Text color="cyan">{'Desglose contexto:  '}</Text>
          <Text color="gray">
            {`System+Tools ~${(contextBreakdown.baseSystemTokens + contextBreakdown.toolSchemaTokens).toLocaleString('en-US')} · Skills (${activeSkillNames.length}) ~${contextBreakdown.activeSkillsTokens.toLocaleString('en-US')} · Historial (${historyTurnCount}) ~${histTokens.toLocaleString('en-US')}`}
          </Text>
        </Box>
        <Box flexDirection="row">
          <Text color="cyan">{'Tiempo último turno:'}</Text>
          <Text color="white">{` ${lastTurnDurationText}`}</Text>
        </Box>
        <Box flexDirection="row">
          <Text color="cyan">{'Costo total sesión: '}</Text>
          <Text color="green" bold>
            {formatChatTotalAmount(chatCostSummary.totalChatCostUsd)}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold color="white">{'Uso y Precios por Modelo (USD / 1M tokens)'}</Text>
          <Text color="gray">
            {`${'Modelo'.padEnd(25, ' ')}${'Reqs'.padStart(5, ' ')}${'Entrada'.padStart(12, ' ')}${'Caché'.padStart(12, ' ')}${'Salida'.padStart(11, ' ')}  ${'Tarifa (In/Caché/Out)'.padEnd(21, ' ')}${'Costo'.padStart(10, ' ')}`}
          </Text>
          <Text color="gray" dimColor>{'─'.repeat(98)}</Text>
          {modelRows.map((row) => (
            <Text key={row.modelId} color="white">
              {`${row.modelId.slice(0, 24).padEnd(25, ' ')}${String(row.reqs).padStart(5, ' ')}${row.inputTokens.toLocaleString('en-US').padStart(12, ' ')}${row.cachedTokens.toLocaleString('en-US').padStart(12, ' ')}${row.outputTokens.toLocaleString('en-US').padStart(11, ' ')}  ${row.rateText.padEnd(21, ' ')}${formatUsdAmount(row.costUsd).padStart(10, ' ')}`}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (showShortcutsPanel && activeDialog === 'none') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color="cyan">
          {`Glitch CLI v${version}  Comandos y atajos (? para ocultar)`}
        </Text>
        <Text color="gray" dimColor>{'─'.repeat(64)}</Text>
        {SLASH_COMMANDS.map((sc) => (
          <Text key={sc.cmd} color="white">
            {`  ${sc.displayCmd.padEnd(20, ' ')} ${sc.desc}`}
          </Text>
        ))}
        <Text color="gray" dimColor>
          {'  Flecha izquierda      Agentes, chats activos e historial'}
        </Text>
        <Text color="gray" dimColor>
          {'  Shift+Tab / Alt+P     Alternar Plan / Agente'}
        </Text>
        <Text color="gray" dimColor>
          {'  Ctrl+T                Plegar / expandir pensamiento'}
        </Text>
        <Text color="gray" dimColor>
          {'  Ctrl+S                Modo selección de texto'}
        </Text>
        <Text color="gray" dimColor>
          {'  Re Pág / Av Pág       Desplazar historial'}
        </Text>
      </Box>
    );
  }

  return null;
};
