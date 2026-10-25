import type { Content } from '@google/genai';
import {
  LOCAL_GOOGLE_MODELS,
  type ModelDefinition,
} from '../config/models.js';
import type { GlitchSettings } from '../config/settings.js';

export class SessionState {
  public settings: GlitchSettings;
  public availableModels: ModelDefinition[];
  public readonly history: Content[] = [];
  public isRequestActive = false;

  constructor(
    initialSettings: GlitchSettings,
    initialModels: readonly ModelDefinition[] = LOCAL_GOOGLE_MODELS,
  ) {
    this.settings = { ...initialSettings };
    this.availableModels = [...initialModels];
  }

  /**
   * Snapshot leído por el AgentLoop justo antes de cada llamada al modelo.
   * Así cualquier cambio en vivo (ej. /effort low o Shift+Tab) aplica
   * inmediatamente en la siguiente llamada de la misma tarea.
   */
  getLiveCallConfig() {
    return {
      model: this.settings.model,
      effort: this.settings.effort,
      includeThoughts: this.settings.thoughts,
      permissionMode: this.settings.permissionMode,
      subMode: this.settings.subMode,
    };
  }
}
