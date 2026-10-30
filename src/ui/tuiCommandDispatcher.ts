import os from 'node:os';
import { runEffortCommand } from '../commands/effort.js';
import {
  applyModelAndOptionalEffort,
  parseModelAndEffortArgs,
} from '../commands/model.js';
import { applySettingOptionValue } from '../commands/settings.js';
import { resolveSlashCommandAlias } from '../commands/slashRegistry.js';
import {
  getModelDefinition,
  type ModelDefinition,
  type ModelFamilyPage,
} from '../config/models.js';
import {
  getAppVersion,
  isAuthConfigured,
  saveSettings,
  type GlitchSettings,
} from '../config/settings.js';
import type { SessionState } from '../core/session.js';
import {
  createSessionId,
  listSavedSessions,
  type SavedSession,
  type SavedUiMessage,
} from '../core/sessionStore.js';
import {
  executeSkillSubcommand,
  type SkillInfo,
} from '../core/skills.js';
import {
  parseGlitchWindowShellCommand,
  spawnGlitchTerminalWindow,
} from '../core/tools.js';
import type { ActiveDialog } from './DialogsView.js';
export interface CommandDispatchContext {
  session: SessionState;
  settings: GlitchSettings;
  messages: SavedUiMessage[];
  sessionId: string;
  availableModels: readonly ModelDefinition[];
  modelPages: readonly ModelFamilyPage[];
  installedSkills: readonly SkillInfo[];
  activeSkillContents: Map<string, string>;
  lastTurnCostUsd: number | null;
  sessionCostUsd: number | null;
  persistCurrentSession: (
    nextMessages: SavedUiMessage[],
    currentId?: string,
    syncImmediate?: boolean,
  ) => void;
  exit: () => void;
  setShowShortcutsPanel: React.Dispatch<React.SetStateAction<boolean>>;
  addSystemMessage: (text: string) => void;
  addUsageMessage?: () => void;
  resetNewSessionUi: (nextId: string) => void;
  resumeSavedSessionUi: (found: SavedSession, prefixText?: string) => void;
  setSavedSessionsList: (list: SavedSession[]) => void;
  setDialogCursor: React.Dispatch<React.SetStateAction<number>>;
  setActiveDialog: (dlg: ActiveDialog) => void;
  setAuthStep: (
    step:
      | 'provider'
      | 'vertex_project'
      | 'vertex_location'
      | 'custom_url'
      | 'custom_key'
      | 'custom_format',
  ) => void;
  setAuthChoiceIdx: React.Dispatch<React.SetStateAction<number>>;
  setAuthBuffer: React.Dispatch<React.SetStateAction<string>>;
  setSettings: (s: GlitchSettings) => void;
  setEditingThresholdMode: (v: boolean) => void;
  setThresholdError: (v: string) => void;
  setPendingModelForEffort: (m: ModelDefinition | null) => void;
  setModelPageIdx: React.Dispatch<React.SetStateAction<number>>;
  syncActiveSkillsFromSet: (names: Set<string>) => void;
  startOrEnqueuePrompt: (prompt: string) => void;
}
export function executeTuiInputCommand(
  raw: string,
  ctx: CommandDispatchContext,
): void {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const resolved = trimmed.startsWith('/')
    ? resolveSlashCommandAlias(trimmed)
    : trimmed;
  if (resolved === '/exit') {
    ctx.persistCurrentSession(ctx.messages, ctx.sessionId, true);
    ctx.exit();
    return;
  }
  if (resolved === '/help' || resolved === '?') {
    ctx.setShowShortcutsPanel((prev) => !prev);
    return;
  }
  if (resolved === '/version') {
    ctx.addSystemMessage(`Glitch CLI v${getAppVersion()}`);
    return;
  }
  if (resolved === '/new') {
    ctx.persistCurrentSession(ctx.messages, ctx.sessionId, true);
    ctx.session.resetForNewSession();
    const nextId = createSessionId();
    ctx.resetNewSessionUi(nextId);
    return;
  }
  if (resolved === '/resume' || resolved.startsWith('/resume ')) {
    const arg = resolved.slice('/resume'.length).trim();
    ctx.persistCurrentSession(ctx.messages, ctx.sessionId, true);
    const list = listSavedSessions();
    if (list.length === 0) {
      ctx.addSystemMessage(
        'No hay conversaciones guardadas todavía para retomar.',
      );
      return;
    }
    if (arg) {
      const byIdx = Number.parseInt(arg, 10);
      const found =
        !Number.isNaN(byIdx) && byIdx >= 1 && byIdx <= list.length
          ? list[byIdx - 1]
          : list.find((s) => s.id === arg);
      if (!found) {
        ctx.addSystemMessage(`No se encontró la conversación "${arg}".`);
        return;
      }
      ctx.resumeSavedSessionUi(
        found,
        `Conversación retomada: "${found.title}" (${found.history.length} turnos).`,
      );
      return;
    }
    ctx.setSavedSessionsList(list);
    ctx.setDialogCursor(0);
    ctx.setActiveDialog('resume');
    return;
  }
  if (resolved === '/auth') {
    ctx.setAuthStep('provider');
    ctx.setAuthChoiceIdx(0);
    ctx.setAuthBuffer('');
    ctx.setActiveDialog('auth');
    return;
  }
  if (resolved === '/settings' || resolved.startsWith('/settings ')) {
    const rawArgs = resolved.slice('/settings'.length).trim();
    if (rawArgs) {
      const spaceIdx = rawArgs.indexOf(' ');
      const optKey = spaceIdx === -1 ? rawArgs : rawArgs.slice(0, spaceIdx);
      const optVal =
        spaceIdx === -1 ? '' : rawArgs.slice(spaceIdx + 1).trim();
      const logs: string[] = [];
      const res = applySettingOptionValue(
        ctx.session.settings,
        optKey,
        optVal,
        (m) => logs.push(m),
        undefined,
        true,
      );
      if (res.changed) {
        ctx.session.settings = res.settings;
        ctx.setSettings({ ...res.settings });
      }
      if (logs.length > 0) {
        ctx.addSystemMessage(logs.join(os.EOL));
      }
      return;
    }
    ctx.setDialogCursor(0);
    ctx.setEditingThresholdMode(false);
    ctx.setThresholdError('');
    ctx.setActiveDialog('settings');
    return;
  }
  if (resolved === '/model' || resolved.startsWith('/model ')) {
    const rawArgs = resolved.slice('/model'.length).trim();
    if (rawArgs) {
      const { modelArg, effortArg } = parseModelAndEffortArgs(
        rawArgs,
        ctx.availableModels,
      );
      const logs: string[] = [];
      const res = applyModelAndOptionalEffort(
        ctx.session.settings,
        ctx.availableModels,
        modelArg,
        effortArg,
        (m) => logs.push(m),
        undefined,
        ctx.session.isRequestActive,
      );
      if (res.changed) {
        ctx.session.settings = res.settings;
        ctx.setSettings({ ...res.settings });
      }
      if (logs.length > 0) {
        ctx.addSystemMessage(logs.join(os.EOL));
      }
      return;
    }
    if (ctx.session.isRequestActive) {
      const curDef = getModelDefinition(
        ctx.session.settings.model,
        ctx.session.settings.provider ?? 'vertex',
      );
      ctx.addSystemMessage(
        `Modelo actual: ${curDef.name} (${ctx.session.settings.model}) | Disponibles: ${ctx.availableModels.map((m) => m.name).join(', ')}`,
      );
      return;
    }
    const foundPageIdx = Math.max(
      0,
      ctx.modelPages.findIndex((p) =>
        p.models.some((m) => m.id === ctx.settings.model),
      ),
    );
    const pageModels = ctx.modelPages[foundPageIdx]?.models ?? [];
    const currentIdx = Math.max(
      0,
      pageModels.findIndex((m) => m.id === ctx.settings.model),
    );
    ctx.setPendingModelForEffort(null);
    ctx.setModelPageIdx(foundPageIdx);
    ctx.setDialogCursor(currentIdx);
    ctx.setActiveDialog('model');
    return;
  }
  if (resolved === '/effort' || resolved.startsWith('/effort ')) {
    const arg = resolved.slice('/effort'.length).trim();
    const cur = ctx.session.settings;
    const def = getModelDefinition(cur.model, cur.provider ?? 'vertex');
    if (!arg) {
      if (def.supportedEfforts.length === 0) {
        ctx.addSystemMessage(
          `El comando /effort no aplica para el modelo actual (${cur.model}): no soporta niveles de esfuerzo (ESFUERZO: N/A).`,
        );
        return;
      }
      const curIdx = Math.max(0, def.supportedEfforts.indexOf(cur.effort));
      ctx.setDialogCursor(curIdx);
      ctx.setActiveDialog('effort');
      return;
    }
    const logs: string[] = [];
    const updated = runEffortCommand(cur, arg, (m) => logs.push(m));
    if (updated !== cur) {
      ctx.session.settings = updated;
      ctx.setSettings({ ...updated });
    }
    if (logs.length > 0) {
      ctx.addSystemMessage(logs.join(os.EOL));
    }
    return;
  }
  if (resolved === '/mcp' || resolved.startsWith('/mcp ')) {
    ctx.setDialogCursor(0);
    ctx.setActiveDialog('mcp');
    return;
  }
  if (resolved === '/skills' || resolved.startsWith('/skills ')) {
    const arg = resolved.slice('/skills'.length).trim();
    if (!arg) {
      ctx.setDialogCursor(0);
      ctx.setActiveDialog('skills');
      return;
    }
    const logs: string[] = [];
    const currentSet = new Set(ctx.activeSkillContents.keys());
    const res = executeSkillSubcommand(
      arg,
      ctx.installedSkills,
      currentSet,
      (m) => logs.push(m),
    );
    ctx.syncActiveSkillsFromSet(res.updatedActiveSkills);
    if (logs.length > 0) {
      ctx.addSystemMessage(logs.join(os.EOL));
    }
    return;
  }
  if (resolved === '/usage' || resolved.startsWith('/usage ')) {
    if (ctx.addUsageMessage) {
      ctx.addUsageMessage();
      return;
    }
    ctx.setDialogCursor(0);
    ctx.setActiveDialog('usage');
    return;
  }
  if (resolved === '/tui' || resolved.startsWith('/tui ')) {
    const arg = resolved.slice('/tui'.length).trim().toLowerCase();
    const currentMode = ctx.session.settings.tuiMode ?? 'default';
    let nextMode: 'default' | 'fullscreen';
    if (arg === 'fullscreen' || arg === 'full' || arg === 'on' || arg === 'tui') {
      nextMode = 'fullscreen';
    } else if (arg === 'default' || arg === 'off' || arg === 'cli') {
      nextMode = 'default';
    } else {
      nextMode = currentMode === 'fullscreen' ? 'default' : 'fullscreen';
    }
    const updated: GlitchSettings = {
      ...ctx.session.settings,
      tuiMode: nextMode,
    };
    ctx.session.settings = updated;
    ctx.setSettings(updated);
    saveSettings(updated);
    ctx.addSystemMessage(
      `Renderizador actual: ${nextMode}. Uso: /tui <default|fullscreen>`,
    );
    return;
  }
  if (resolved.startsWith('/')) {
    ctx.addSystemMessage(
      `Comando desconocido: ${trimmed}. Usa /ayuda para ver los comandos disponibles.`,
    );
    return;
  }
  const windowLaunch = parseGlitchWindowShellCommand(trimmed);
  if (windowLaunch) {
    const res = spawnGlitchTerminalWindow({
      ...windowLaunch,
      cwd: process.cwd(),
    });
    ctx.addSystemMessage(res.error ?? res.result ?? 'Nueva ventana abierta.');
    return;
  }
  if (!isAuthConfigured(ctx.session.settings)) {
    ctx.addSystemMessage('Configura primero tu conexión con /auth.');
    ctx.setActiveDialog('auth');
    return;
  }
  ctx.startOrEnqueuePrompt(trimmed);
}
