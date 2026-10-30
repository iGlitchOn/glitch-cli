import React from 'react';
import { Box, Text } from 'ink';
import { getSettingHelpDetail } from '../commands/settings.js';
import {
  formatModelRowColumns,
  getModelDefinition,
  type ModelDefinition,
  type ModelFamilyPage,
} from '../config/models.js';
import {
  CURRENT_PRICING_VERSION,
  formatAuthSummary,
  formatPermissionModeLabel,
  formatSubModeLabel,
  type EffortLevel,
  type GlitchSettings,
} from '../config/settings.js';
import { splitTextForCursorRender } from '../core/lineEditor.js';
import type { McpServerEntry } from '../core/mcpRegistry.js';
import { cleanSessionTitle, type SavedSession } from '../core/sessionStore.js';
import type { SkillInfo } from '../core/skills.js';
import { InspectorDialogsView } from './InspectorDialogsView.js';
import type {
  ChatCostSummary,
  ContextUsageBreakdown,
  CostRequestRecord,
} from './statusBar.js';

export type ActiveDialog =
  | 'none'
  | 'auth'
  | 'model'
  | 'effort'
  | 'settings'
  | 'resume'
  | 'agents_chats'
  | 'mcp'
  | 'skills'
  | 'usage'
  | 'ask_user';

export interface PendingAskUserPrompt {
  question: string;
  header?: string;
  options: string[];
  resolve: (answer: string) => void;
}

export const DaaSplashView: React.FC<{ seconds: number }> = ({ seconds }) => (
  <Box flexDirection="column" paddingX={2} paddingY={1} margin={1}>
    <Text bold color="red">
      {'ADVERTENCIA DE SEGURIDAD: FLAG --DAA (--dangerously-always-allow) DETECTADA'}
    </Text>
    <Box marginTop={1} flexDirection="column">
      <Text color="yellow">
        {'- Has iniciado Glitch CLI con --DAA: modo Always Allow y SIN SANDBOX.'}
      </Text>
      <Text color="yellow">
        {'- Tiene acceso completo a todo tu PC sin importar desde qué carpeta lo abras.'}
      </Text>
      <Text color="yellow">
        {'- Ninguna acción o modificación pedirá confirmación manual mientras este modo esté activo.'}
      </Text>
    </Box>
    <Box marginTop={1}>
      <Text color="white" bold>
        {`Iniciando Glitch CLI en ${seconds} segundos...`}
      </Text>
    </Box>
    <Text color="gray" dimColor>
      {'(Puedes desactivar esta advertencia inicial en /ajustes -> Advertencia --DAA al inicio: OFF)'}
    </Text>
  </Box>
);

export interface DialogsViewProps {
  activeDialog: ActiveDialog;
  settings: GlitchSettings;
  version: string;
  dialogCursor: number;
  savedSessionsList: readonly SavedSession[];
  authStep:
    | 'provider'
    | 'vertex_project'
    | 'vertex_location'
    | 'custom_url'
    | 'custom_key'
    | 'custom_format';
  authChoiceIdx: number;
  authBuffer: string;
  modelPages: readonly ModelFamilyPage[];
  modelPageIdx: number;
  pendingModelForEffort: ModelDefinition | null;
  modelEffortIdx: number;
  editingThresholdMode: boolean;
  thresholdBuffer: string;
  thresholdError: string;
  pendingAskUser: PendingAskUserPrompt | null;
  askUserCursor: number;
  askUserCustomText: string;
  askUserCustomCursor: number;
  askUserTypingCustom: boolean;
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

export const DialogsView: React.FC<DialogsViewProps> = (props) => {
  const {
    activeDialog,
    settings,
    dialogCursor,
    savedSessionsList,
    authStep,
    authChoiceIdx,
    authBuffer,
    modelPages,
    modelPageIdx,
    pendingModelForEffort,
    modelEffortIdx,
    editingThresholdMode,
    thresholdBuffer,
    thresholdError,
    pendingAskUser,
    askUserCursor,
    askUserCustomText,
    askUserCustomCursor,
    askUserTypingCustom,
  } = props;

  if (activeDialog === 'resume') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color="cyan">
          {'Retomar conversación (/resume)  enter cargar  esc salir'}
        </Text>
        <Text color="gray" dimColor>
          {'─'.repeat(64)}
        </Text>
        {savedSessionsList.map((s, idx) => {
          const isSelected = idx === dialogCursor;
          const displayTitle = cleanSessionTitle(s.title);
          return (
            <Text key={s.id} color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
              {isSelected ? '> ' : '  '}
              {displayTitle.padEnd(48, ' ')}  {s.model.padEnd(24, ' ')}  {s.updatedAt}
            </Text>
          );
        })}
      </Box>
    );
  }

  if (activeDialog === 'auth') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color="cyan">{'Configuración de autenticación (/auth)'}</Text>
        <Text color="gray" dimColor>{`Actual: ${formatAuthSummary(settings)}`}</Text>
        {authStep === 'provider' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Selecciona proveedor (enter confirmar):'}</Text>
            <Text color={authChoiceIdx === 0 ? 'cyan' : 'white'} bold={authChoiceIdx === 0}>
              {authChoiceIdx === 0 ? '> ' : '  '}1. Vertex AI (Application Default Credentials)
            </Text>
            <Text color={authChoiceIdx === 1 ? 'cyan' : 'white'} bold={authChoiceIdx === 1}>
              {authChoiceIdx === 1 ? '> ' : '  '}2. API personalizada (/v1/chat/completions o /v1/responses)
            </Text>
          </Box>
        )}
        {authStep === 'vertex_project' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Proyecto GCP (GOOGLE_CLOUD_PROJECT):'}</Text>
            <Text color="cyan">{`> ${authBuffer}`}</Text>
          </Box>
        )}
        {authStep === 'vertex_location' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Región GCP (GOOGLE_CLOUD_LOCATION):'}</Text>
            <Text color="cyan">{`> ${authBuffer}`}</Text>
          </Box>
        )}
        {authStep === 'custom_url' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Base URL del proveedor personalizado:'}</Text>
            <Text color="cyan">{`> ${authBuffer}`}</Text>
          </Box>
        )}
        {authStep === 'custom_key' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'API Key (se guardará enmascarada):'}</Text>
            <Text color="cyan">
              {`> ${authBuffer ? '*'.repeat(Math.min(authBuffer.length, 24)) : ''}`}
            </Text>
          </Box>
        )}
        {authStep === 'custom_format' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Selecciona el formato del endpoint (enter confirmar):'}</Text>
            <Text color={authChoiceIdx === 0 ? 'cyan' : 'white'} bold={authChoiceIdx === 0}>
              {authChoiceIdx === 0 ? '> ' : '  '}1. /v1/chat/completions
            </Text>
            <Text color={authChoiceIdx === 1 ? 'cyan' : 'white'} bold={authChoiceIdx === 1}>
              {authChoiceIdx === 1 ? '> ' : '  '}2. /v1/responses
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (activeDialog === 'model') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text bold color="cyan">{'Modelos (/model)'}</Text>
          <Text color="gray" dimColor>{'cambiar familia  elegir  enter confirmar  esc salir'}</Text>
        </Box>
        {pendingModelForEffort ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="white">
              {`Nivel de esfuerzo para ${pendingModelForEffort.name} (enter confirmar, esc volver):`}
            </Text>
            <Box flexDirection="row" marginTop={1}>
              {pendingModelForEffort.supportedEfforts.map((ef, idx) => {
                const isChosen = idx === modelEffortIdx;
                return (
                  <Box key={ef} marginRight={3}>
                    <Text bold={isChosen} color={isChosen ? 'cyan' : 'gray'}>
                      {isChosen ? `> ${ef.toUpperCase()}` : `  ${ef.toUpperCase()}`}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        ) : (
          <>
            <Box flexDirection="row" marginBottom={1}>
              {modelPages.map((page, pIdx) => {
                const isCurrentPage = pIdx === modelPageIdx;
                return (
                  <Box key={page.family} marginRight={2}>
                    <Text bold={isCurrentPage} color={isCurrentPage ? 'cyan' : 'gray'} dimColor={!isCurrentPage}>
                      {`${pIdx + 1}/${modelPages.length} ${page.title}`}
                    </Text>
                  </Box>
                );
              })}
            </Box>
            <Text color="gray" dimColor>{'  ' + '─'.repeat(96)}</Text>
            {(modelPages[modelPageIdx]?.models ?? []).map((m, idx) => {
              const isSelected = idx === dialogCursor;
              const isCurrent = m.id === settings.model;
              const cols = formatModelRowColumns(m, isCurrent, 36, 32, 10);
              return (
                <Box key={m.id} flexDirection="row">
                  <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                    {isSelected ? '> ' : '  '}
                    {cols.nameCol}
                  </Text>
                  <Text color="gray" dimColor>{`  ${cols.idCol}  ${cols.dateCol}  ${cols.effortsCol}`}</Text>
                </Box>
              );
            })}
          </>
        )}
      </Box>
    );
  }

  if (activeDialog === 'settings') {
    const detail = getSettingHelpDetail(dialogCursor);
    const activePriceEntry = settings.modelPricing?.[settings.model];
    const priceSummary = activePriceEntry
      ? `${settings.model}: $${activePriceEntry.inputPerMillion}/$${activePriceEntry.outputPerMillion}/$${activePriceEntry.cachePerMillion} (v${settings.pricingVersion ?? CURRENT_PRICING_VERSION})`
      : `v${settings.pricingVersion ?? CURRENT_PRICING_VERSION}`;

    const rows: Array<{ label: string; value: string }> = [
      { label: 'Modo de permisos', value: formatPermissionModeLabel(settings.permissionMode) },
      { label: 'Sub-Modo', value: formatSubModeLabel(settings.subMode) },
      { label: 'Esfuerzo por defecto', value: settings.effort.toUpperCase() },
      { label: 'Thoughts', value: settings.thoughts ? 'ON' : 'OFF' },
      { label: 'Advertencia --DAA al inicio', value: settings.hideDaaWarning ? 'OFF' : 'ON' },
      { label: 'Preguntas de la IA (ask_user)', value: (settings.allowAgentQuestions ?? true) ? 'ON' : 'OFF' },
      { label: 'Autocompactación', value: (settings.autoCompact ?? true) ? 'ON' : 'OFF' },
      {
        label: 'Umbral de autocompactación',
        value:
          editingThresholdMode && dialogCursor === 7
            ? `${thresholdBuffer} (enter guardar · esc cancelar)`
            : `${settings.autoCompactThreshold ?? 70}%`,
      },
      { label: 'thinkingDisplay', value: settings.thinkingDisplay ?? 'expandido' },
      {
        label: 'thinkingSummaryModel',
        value:
          editingThresholdMode && dialogCursor === 9
            ? `${thresholdBuffer} (enter guardar · esc cancelar)`
            : settings.thinkingSummaryModel ?? 'gemini-3.1-pro-preview',
      },
      {
        label: 'subagentMaxSteps',
        value:
          editingThresholdMode && dialogCursor === 10
            ? `${thresholdBuffer} (enter guardar · esc cancelar)`
            : (settings.subagentMaxSteps ?? 0) === 0
              ? '0 (sin límite)'
              : String(settings.subagentMaxSteps),
      },
      {
        label: 'regionalSurchargePct',
        value:
          editingThresholdMode && dialogCursor === 11
            ? `${thresholdBuffer}% (enter guardar · esc cancelar)`
            : `${settings.regionalSurchargePct ?? 0}%`,
      },
      {
        label: 'Tabla de precios',
        value:
          editingThresholdMode && dialogCursor === 12
            ? `${thresholdBuffer} (formato: modelo in out cache · enter guardar)`
            : priceSummary,
      },
      { label: 'Atajo de pensamiento', value: settings.toggleThoughtsShortcut ?? 'ctrl+t' },
    ];

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text bold color="cyan">
            {'Ajustes (/settings)'}
          </Text>
          <Text color="gray" dimColor>
            {'seleccionar  enter cambiar  esc cerrar'}
          </Text>
        </Box>
        {rows.map((r, idx) => {
          const isSel = dialogCursor === idx;
          return (
            <Text key={r.label} color={isSel ? 'cyan' : 'white'} bold={isSel}>
              {isSel ? '> ' : '  '}
              {r.label.padEnd(32, ' ')} : {r.value}
            </Text>
          );
        })}
        {thresholdError !== '' && (
          <Text color="red" bold>{`  ${thresholdError}`}</Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" dimColor>{'─'.repeat(72)}</Text>
          <Text bold color="cyan">{detail.title}</Text>
          <Text color="gray" dimColor>{`${detail.availableModesLabel} ${detail.availableModes}`}</Text>
          <Text color="gray">{detail.whatItDoes}</Text>
        </Box>
      </Box>
    );
  }

  if (activeDialog === 'ask_user' && pendingAskUser) {
    const askSlices = splitTextForCursorRender(askUserCustomText, askUserCustomCursor);
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text bold color="cyan">
            {`${pendingAskUser.header ? `[${pendingAskUser.header}] ` : ''}Pregunta de la IA`}
          </Text>
          <Text color="gray" dimColor>
            {askUserTypingCustom
              ? 'escribe respuesta + enter  esc volver'
              : 'elegir opción  enter confirmar'}
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text bold color="white">{pendingAskUser.question}</Text>
        </Box>
        {!askUserTypingCustom ? (
          <Box flexDirection="column">
            {pendingAskUser.options.map((opt, idx) => {
              const isSel = idx === askUserCursor;
              return (
                <Text key={idx} color={isSel ? 'cyan' : 'white'} bold={isSel}>
                  {isSel ? '> ' : '  '}
                  {`${idx + 1}. ${opt}`}
                </Text>
              );
            })}
            <Text
              color={askUserCursor === pendingAskUser.options.length ? 'cyan' : 'gray'}
              bold={askUserCursor === pendingAskUser.options.length}
            >
              {askUserCursor === pendingAskUser.options.length ? '> ' : '  '}
              {`${pendingAskUser.options.length + 1}. Escribir respuesta libre...`}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color="gray" dimColor>{'Escribe tu respuesta:'}</Text>
            <Text color="cyan" bold>
              {'> '}
              {askSlices.isAtEnd ? (
                <>
                  {askSlices.beforeCursor}
                  <Text inverse bold>{' '}</Text>
                </>
              ) : (
                <>
                  {askSlices.beforeCursor}
                  <Text inverse bold>{askSlices.cursorChar}</Text>
                  {askSlices.afterCursor}
                </>
              )}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (activeDialog === 'effort') {
    const def = getModelDefinition(settings.model, settings.provider ?? 'vertex');
    const efforts = def.supportedEfforts;
    const effortDescEs: Record<EffortLevel, string> = {
      low: 'Respuesta rápida con razonamiento ligero',
      medium: 'Equilibrio entre velocidad y profundidad',
      high: 'Razonamiento profundo para tareas complejas',
    };
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text bold color="cyan">{`Esfuerzo (/effort)  ${def.name}`}</Text>
          <Text color="gray" dimColor>{'elegir  enter aplicar  esc cerrar'}</Text>
        </Box>
        {efforts.map((ef, idx) => {
          const isSelected = idx === dialogCursor;
          const isCurrent = ef === settings.effort;
          return (
            <Box key={ef} flexDirection="row">
              <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected || isCurrent}>
                {isSelected ? '> ' : '  '}
                {`${idx + 1}. ${ef.toUpperCase().padEnd(8, ' ')}`}
              </Text>
              {isCurrent && <Text color="green" bold>{'en vivo  '}</Text>}
              <Text color="gray" dimColor>{effortDescEs[ef]}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  return <InspectorDialogsView {...props} />;
};
