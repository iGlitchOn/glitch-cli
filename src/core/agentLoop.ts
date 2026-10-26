import type { Part } from '@google/genai';
import type { OutputFn } from '../commands/auth.js';
import type {
  ProviderAdapter,
  ProviderRequestOptions,
} from '../providers/types.js';
import type { SessionState } from './session.js';

export interface AgentTaskStepHook {
  shouldContinueTask?: (
    stepIndex: number,
    lastReplyText: string,
    session: SessionState,
  ) => Promise<boolean> | boolean;
}

export class AgentLoop {
  private readonly queue: string[] = [];
  private processingPromise: Promise<void> | null = null;
  public readonly recordedCallConfigs: ProviderRequestOptions[] = [];

  constructor(
    private readonly session: SessionState,
    private readonly getAdapter: () => ProviderAdapter,
    private readonly onStreamText: OutputFn = (text) =>
      process.stdout.write(text),
    private readonly onError: OutputFn = (msg) => console.error(msg),
    private readonly stepHook?: AgentTaskStepHook,
  ) {}

  getQueuedPrompts(): readonly string[] {
    return this.queue;
  }

  /**
   * Actualiza un prompt en la cola en su misma posición sin alterar el resto de la fila.
   * Por ejemplo, si hay 3 elementos en cola [0, 1, 2], subir 2 veces apunta al índice 1 (el 2do prompt).
   */
  updateQueuedPromptAt(index: number, newText: string): boolean {
    const trimmed = newText.trim();
    if (!trimmed || index < 0 || index >= this.queue.length) {
      return false;
    }
    this.queue[index] = trimmed;
    return true;
  }

  /**
   * Obtiene el índice en la cola al presionar la flecha ↑ `stepsUp` veces (1 = último encolado, 2 = penúltimo, etc.).
   */
  getQueueIndexFromStepsUp(stepsUp: number): number {
    if (stepsUp <= 0 || this.queue.length === 0) {
      return -1;
    }
    return Math.max(0, this.queue.length - stepsUp);
  }

  enqueuePrompt(userText: string): Promise<void> {
    const trimmed = userText.trim();
    if (!trimmed || trimmed.startsWith('/')) {
      return Promise.resolve();
    }
    this.queue.push(trimmed);
    if (!this.processingPromise) {
      this.processingPromise = this.drainQueue().finally(() => {
        this.processingPromise = null;
      });
    }
    return this.processingPromise;
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const prompt = this.queue.shift()!;
      await this.runTask(prompt);
    }
  }

  private async runTask(prompt: string): Promise<void> {
    this.session.isRequestActive = true;
    this.session.history.push({
      role: 'user',
      parts: [{ text: prompt }],
    });

    try {
      let stepIndex = 0;
      let keepGoing = true;

      while (keepGoing) {
        // Lee effort, modo, sub-modo y thoughts en vivo antes de CADA llamada al modelo
        const live = this.session.getLiveCallConfig();
        const requestOptions: ProviderRequestOptions = {
          model: live.model,
          effort: live.effort,
          includeThoughts: live.includeThoughts,
          subMode: live.subMode,
        };
        this.recordedCallConfigs.push(requestOptions);

        const adapter = this.getAdapter();
        const collectedParts: Part[] = [];
        let stepText = '';

        for await (const chunk of adapter.streamTurn(
          this.session.history,
          requestOptions,
        )) {
          if (chunk.rawParts && chunk.rawParts.length > 0) {
            collectedParts.push(...chunk.rawParts);
          }
          if (chunk.text) {
            this.onStreamText(chunk.text);
            stepText += chunk.text;
          }
        }

        this.session.history.push({
          role: 'model',
          parts:
            collectedParts.length > 0
              ? collectedParts
              : [{ text: stepText }],
        });

        stepIndex++;
        if (this.stepHook?.shouldContinueTask) {
          keepGoing = await this.stepHook.shouldContinueTask(
            stepIndex,
            stepText,
            this.session,
          );
        } else {
          keepGoing = false;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onError(`✗ Error en llamada al modelo: ${msg}`);
    } finally {
      this.session.isRequestActive = false;
    }
  }
}
