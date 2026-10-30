import type { Content } from '@google/genai';
import {
  LOCAL_GOOGLE_MODELS,
  resolveEffectiveEffortForModel,
  type ModelDefinition,
} from '../config/models.js';
import type { GlitchSettings } from '../config/settings.js';
import type { CostRequestRecord } from '../ui/statusBar.js';
import {
  countCompletedConversationTurns,
  type SavedSession,
} from './sessionStore.js';

export class SessionState {
  public settings: GlitchSettings;
  public availableModels: ModelDefinition[];
  public readonly history: Content[] = [];
  public isRequestActive = false;
  public onWarning?: (msg: string) => void;
  public readonly costRecords: CostRequestRecord[] = [];
  public sessionCostUsd: number | null = null;
  public unknownPriceRequestCount = 0;
  public lastApiPromptTokenCount: number | null = null;
  public turnCounter = 0;
  public completedTurnsCount = 0;
  public customTitle?: string;
  public titleGeneratedAtTurn = 0;

  constructor(
    initialSettings: GlitchSettings,
    initialModels: readonly ModelDefinition[] = LOCAL_GOOGLE_MODELS,
    onWarning?: (msg: string) => void,
  ) {
    this.settings = { ...initialSettings };
    this.availableModels = [...initialModels];
    this.onWarning = onWarning;
  }

  resetForNewSession(): void {
    this.history.length = 0;
    this.costRecords.length = 0;
    this.sessionCostUsd = null;
    this.unknownPriceRequestCount = 0;
    this.lastApiPromptTokenCount = null;
    this.turnCounter = 0;
    this.completedTurnsCount = 0;
    this.customTitle = undefined;
    this.titleGeneratedAtTurn = 0;
  }

  restoreFromSavedSession(saved: SavedSession): void {
    this.history.length = 0;
    this.history.push(...saved.history);
    this.costRecords.length = 0;
    if (Array.isArray(saved.costRecords)) {
      this.costRecords.push(...saved.costRecords);
    }
    this.unknownPriceRequestCount = this.costRecords.filter(
      (r) => r.costUsd === null,
    ).length;
    const knownRecords = this.costRecords.filter((r) => r.costUsd !== null);
    if (typeof saved.sessionCostUsd === 'number') {
      this.sessionCostUsd = saved.sessionCostUsd;
    } else if (knownRecords.length > 0) {
      this.sessionCostUsd = knownRecords.reduce(
        (acc, r) => acc + (r.costUsd ?? 0),
        0,
      );
    } else {
      this.sessionCostUsd = null;
    }
    this.lastApiPromptTokenCount =
      typeof saved.lastApiPromptTokens === 'number' &&
      saved.lastApiPromptTokens > 0
        ? saved.lastApiPromptTokens
        : null;
    const maxTurn = this.costRecords.reduce(
      (m, r) => Math.max(m, r.turnIndex),
      0,
    );
    this.turnCounter = Math.max(
      maxTurn,
      this.history.filter((h) => h.role === 'user').length,
    );
    this.completedTurnsCount =
      typeof saved.completedTurnsCount === 'number' &&
      saved.completedTurnsCount >= 0
        ? saved.completedTurnsCount
        : Array.isArray(saved.messages)
          ? countCompletedConversationTurns(saved.messages)
          : 0;
    this.customTitle =
      typeof saved.customTitle === 'string' && saved.customTitle.trim().length > 0
        ? saved.customTitle.trim()
        : undefined;
    this.titleGeneratedAtTurn =
      typeof saved.titleGeneratedAtTurn === 'number'
        ? saved.titleGeneratedAtTurn
        : 0;
  }

  getLiveCallConfig(outWarning?: (msg: string) => void) {
    const provider = this.settings.provider ?? 'vertex';
    const resolution = resolveEffectiveEffortForModel(
      this.settings.model,
      this.settings.effort,
      provider,
    );
    if (resolution.wasAdjusted) {
      this.settings.effort = resolution.effectiveEffort;
      if (resolution.warningMessage) {
        (outWarning ?? this.onWarning)?.(resolution.warningMessage);
      }
    }
    return {
      model: this.settings.model,
      effort: resolution.effectiveEffort,
      includeThoughts: this.settings.thoughts,
      permissionMode: this.settings.permissionMode,
      subMode: this.settings.subMode,
      allowAgentQuestions: this.settings.allowAgentQuestions ?? true,
    };
  }
}
