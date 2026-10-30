import {
  restorePastedImageMap,
  snapshotPastedImageMap,
  transformPastedChunkWithImages,
  unregisterPastedImageTag,
} from './clipboard.js';

export interface LineEditorState {
  text: string;
  cursor: number;
}

export interface LineHistorySnapshot {
  text: string;
  cursor: number;
  imageRefs: Map<string, string>;
}

export type UndoActionKind =
  | 'type_char'
  | 'delete_char'
  | 'delete_word'
  | 'paste'
  | 'load_queue';

export const MAX_UNDO_HISTORY_STEPS = 100;
export const UNDO_GROUP_TIMEOUT_MS = 1000;

function extractImageTagNames(text: string): Set<string> {
  const tags = new Set<string>();
  const rx = /\[([^\[\]\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp))\]/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text)) !== null) {
    if (match[1]) {
      tags.add(match[1].trim().toLowerCase());
    }
  }
  return tags;
}

function syncClipboardRefsBetweenStates(
  previousText: string,
  targetSnapshot: LineHistorySnapshot,
): void {
  restorePastedImageMap(targetSnapshot.imageRefs);
  const prevTags = extractImageTagNames(previousText);
  const nextTags = extractImageTagNames(targetSnapshot.text);
  for (const tag of prevTags) {
    if (!nextTags.has(tag)) {
      unregisterPastedImageTag(tag);
    }
  }
}

export class InputUndoManager {
  private undoStack: LineHistorySnapshot[] = [];
  private redoStack: LineHistorySnapshot[] = [];
  private activeGroup: 'none' | 'typing' | 'deleting' = 'none';
  private lastActionTimestamp = 0;

  constructor(private readonly maxSteps = MAX_UNDO_HISTORY_STEPS) {}

  getUndoCount(): number {
    return this.undoStack.length;
  }

  getRedoCount(): number {
    return this.redoStack.length;
  }

  /**
   * Cierra el grupo de escritura/borrado actual (ej. al mover el cursor con flechas/Home/End).
   */
  breakGroup(): void {
    this.activeGroup = 'none';
  }

  /**
   * Vacía por completo el historial de deshacer/rehacer (ej. al enviar el mensaje con Enter).
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.activeGroup = 'none';
    this.lastActionTimestamp = 0;
  }

  private pushUndoSnapshot(state: LineEditorState): void {
    const snap: LineHistorySnapshot = {
      text: state.text,
      cursor: clampCursor(state.text, state.cursor),
      imageRefs: snapshotPastedImageMap(),
    };
    const top = this.undoStack.at(-1);
    if (top && top.text === snap.text && top.cursor === snap.cursor) {
      return;
    }
    this.undoStack.push(snap);
    if (this.undoStack.length > this.maxSteps) {
      this.undoStack.shift();
    }
  }

  /**
   * Registra una transición de `beforeState` -> `afterState` según el tipo de edición:
   * - `paste`, `delete_word`, `load_queue`: siempre crean un punto de deshacer independiente y cierran grupo.
   * - `type_char`: agrupa caracteres seguidos en un solo paso; cierra grupo si pasó >= 1s o al escribir espacio (' ').
   * - `delete_char`: agrupa borrados seguidos en un solo paso; cierra grupo si pasó >= 1s.
   */
  recordEdit(
    beforeState: LineEditorState,
    afterState: LineEditorState,
    kind: UndoActionKind,
    insertedText = '',
    nowMs: number = Date.now(),
    beforeImageRefs?: Map<string, string>,
  ): void {
    if (
      beforeState.text === afterState.text &&
      beforeState.cursor === afterState.cursor
    ) {
      return;
    }

    // Cualquier edición nueva invalida el historial de rehacer
    this.redoStack = [];

    const elapsed = nowMs - this.lastActionTimestamp;
    const isTimedOut = elapsed >= UNDO_GROUP_TIMEOUT_MS;

    if (kind === 'paste' || kind === 'delete_word' || kind === 'load_queue') {
      this.pushUndoSnapshotWithRefs(beforeState, beforeImageRefs);
      this.activeGroup = 'none';
      this.lastActionTimestamp = nowMs;
      return;
    }

    if (kind === 'type_char') {
      if (this.activeGroup !== 'typing' || isTimedOut) {
        this.pushUndoSnapshotWithRefs(beforeState, beforeImageRefs);
        this.activeGroup = 'typing';
      }
      this.lastActionTimestamp = nowMs;
      // Si el usuario escribió un espacio, cerramos el grupo para que la siguiente palabra sea otro paso
      if (insertedText.includes(' ')) {
        this.activeGroup = 'none';
      }
      return;
    }

    if (kind === 'delete_char') {
      if (this.activeGroup !== 'deleting' || isTimedOut) {
        this.pushUndoSnapshotWithRefs(beforeState, beforeImageRefs);
        this.activeGroup = 'deleting';
      }
      this.lastActionTimestamp = nowMs;
    }
  }

  private pushUndoSnapshotWithRefs(
    state: LineEditorState,
    customImageRefs?: Map<string, string>,
  ): void {
    const snap: LineHistorySnapshot = {
      text: state.text,
      cursor: clampCursor(state.text, state.cursor),
      imageRefs: customImageRefs
        ? new Map(customImageRefs)
        : snapshotPastedImageMap(),
    };
    const top = this.undoStack.at(-1);
    if (top && top.text === snap.text && top.cursor === snap.cursor) {
      return;
    }
    this.undoStack.push(snap);
    if (this.undoStack.length > this.maxSteps) {
      this.undoStack.shift();
    }
  }

  /**
   * Ctrl+Z: restaura el estado anterior (texto, posición del cursor y referencias de imágenes).
   * Si no hay nada que deshacer, devuelve `null`.
   */
  undo(currentState: LineEditorState): LineEditorState | null {
    if (this.undoStack.length === 0) {
      return null;
    }
    this.activeGroup = 'none';
    const currentSnapshot: LineHistorySnapshot = {
      text: currentState.text,
      cursor: clampCursor(currentState.text, currentState.cursor),
      imageRefs: snapshotPastedImageMap(),
    };
    this.redoStack.push(currentSnapshot);
    if (this.redoStack.length > this.maxSteps) {
      this.redoStack.shift();
    }

    const target = this.undoStack.pop()!;
    syncClipboardRefsBetweenStates(currentState.text, target);
    return {
      text: target.text,
      cursor: clampCursor(target.text, target.cursor),
    };
  }

  /**
   * Ctrl+Y / Ctrl+Shift+Z: vuelve a aplicar el paso deshecho.
   * Si no hay nada que rehacer, devuelve `null`.
   */
  redo(currentState: LineEditorState): LineEditorState | null {
    if (this.redoStack.length === 0) {
      return null;
    }
    this.activeGroup = 'none';
    const currentSnapshot: LineHistorySnapshot = {
      text: currentState.text,
      cursor: clampCursor(currentState.text, currentState.cursor),
      imageRefs: snapshotPastedImageMap(),
    };
    this.undoStack.push(currentSnapshot);
    if (this.undoStack.length > this.maxSteps) {
      this.undoStack.shift();
    }

    const target = this.redoStack.pop()!;
    syncClipboardRefsBetweenStates(currentState.text, target);
    return {
      text: target.text,
      cursor: clampCursor(target.text, target.cursor),
    };
  }
}

export function clampCursor(text: string, cursor: number): number {
  return Math.max(0, Math.min(text.length, cursor));
}

export function createLineEditorState(text = ''): LineEditorState {
  return {
    text,
    cursor: text.length,
  };
}

export function moveCursorLeft(
  state: LineEditorState,
  byWord = false,
): LineEditorState {
  const cur = clampCursor(state.text, state.cursor);
  if (cur <= 0) {
    return { text: state.text, cursor: 0 };
  }
  if (!byWord) {
    return { text: state.text, cursor: cur - 1 };
  }

  let i = cur;
  while (i > 0 && /\s/.test(state.text[i - 1]!)) {
    i--;
  }
  while (i > 0 && !/\s/.test(state.text[i - 1]!)) {
    i--;
  }
  return { text: state.text, cursor: i };
}

export function moveCursorRight(
  state: LineEditorState,
  byWord = false,
): LineEditorState {
  const cur = clampCursor(state.text, state.cursor);
  if (cur >= state.text.length) {
    return { text: state.text, cursor: state.text.length };
  }
  if (!byWord) {
    return { text: state.text, cursor: cur + 1 };
  }

  let i = cur;
  while (i < state.text.length && /\s/.test(state.text[i]!)) {
    i++;
  }
  while (i < state.text.length && !/\s/.test(state.text[i]!)) {
    i++;
  }
  return { text: state.text, cursor: i };
}

export function moveCursorHome(state: LineEditorState): LineEditorState {
  return { text: state.text, cursor: 0 };
}

export function moveCursorEnd(state: LineEditorState): LineEditorState {
  return { text: state.text, cursor: state.text.length };
}

export function insertTextAtCursor(
  state: LineEditorState,
  inserted: string,
): LineEditorState {
  if (!inserted) {
    return state;
  }
  const cur = clampCursor(state.text, state.cursor);
  const nextText =
    state.text.slice(0, cur) + inserted + state.text.slice(cur);
  return {
    text: nextText,
    cursor: cur + inserted.length,
  };
}

/**
 * Inserta un bloque pegado (con o sin secuencias \x1b[200~..\x1b[201~) conservando
 * los saltos de línea (\n) tal cual y registrándolo como un único paso de deshacer/rehacer.
 */
export function applyBracketedPasteToEditor(
  state: LineEditorState,
  rawPasted: string,
  undoManager: InputUndoManager,
  nowMs: number = Date.now(),
): LineEditorState {
  const beforeRefs = snapshotPastedImageMap();
  const processed = transformPastedChunkWithImages(rawPasted);
  if (!processed) {
    return state;
  }
  const nextState = insertTextAtCursor(state, processed);
  undoManager.recordEdit(
    state,
    nextState,
    'paste',
    processed,
    nowMs,
    beforeRefs,
  );
  return nextState;
}

export function deleteBackwardAtCursor(
  state: LineEditorState,
): LineEditorState {
  const cur = clampCursor(state.text, state.cursor);
  if (cur <= 0 || state.text.length === 0) {
    return { text: state.text, cursor: 0 };
  }
  const nextText = state.text.slice(0, cur - 1) + state.text.slice(cur);
  return {
    text: nextText,
    cursor: cur - 1,
  };
}

export function deleteWordBackwardAtCursor(
  state: LineEditorState,
): LineEditorState {
  const cur = clampCursor(state.text, state.cursor);
  if (cur <= 0 || state.text.length === 0) {
    return { text: state.text, cursor: 0 };
  }
  const target = moveCursorLeft(state, true).cursor;
  const nextText = state.text.slice(0, target) + state.text.slice(cur);
  return {
    text: nextText,
    cursor: target,
  };
}

export function deleteForwardAtCursor(
  state: LineEditorState,
): LineEditorState {
  const cur = clampCursor(state.text, state.cursor);
  if (state.text.length === 0) {
    return { text: '', cursor: 0 };
  }
  if (cur < state.text.length) {
    const nextText = state.text.slice(0, cur) + state.text.slice(cur + 1);
    return {
      text: nextText,
      cursor: cur,
    };
  }
  return deleteBackwardAtCursor(state);
}

export interface CursorRenderSlices {
  beforeCursor: string;
  cursorChar: string;
  afterCursor: string;
  isAtEnd: boolean;
}

export function splitTextForCursorRender(
  text: string,
  cursor: number,
): CursorRenderSlices {
  const cur = clampCursor(text, cursor);
  if (cur >= text.length) {
    return {
      beforeCursor: text,
      cursorChar: ' ',
      afterCursor: '',
      isAtEnd: true,
    };
  }
  return {
    beforeCursor: text.slice(0, cur),
    cursorChar: text[cur]!,
    afterCursor: text.slice(cur + 1),
    isAtEnd: false,
  };
}

/**
 * Formatea un elemento de la cola en una sola línea truncada al ancho real de la terminal:
 * `> #1 - inicio del mensaje...` (si está seleccionado) o `  #1 - inicio del mensaje...`
 * sin modificar jamás el mensaje completo almacenado en la cola.
 */
export function formatQueueItemDisplayLine(
  fullMessage: string,
  indexOneBased: number,
  isSelected: boolean,
  terminalColumns: number,
): string {
  const marker = isSelected ? '> ' : '  ';
  const prefix = `${marker}#${indexOneBased} - `;
  const singleLineMsg = fullMessage.replace(/[\r\n]+/g, ' ').trim();
  const availableForMsg = Math.max(10, terminalColumns - prefix.length - 6);

  if (singleLineMsg.length <= availableForMsg) {
    return `${prefix}${singleLineMsg}`;
  }

  const sliceLen = Math.max(1, availableForMsg - 3);
  return `${prefix}${singleLineMsg.slice(0, sliceLen)}...`;
}

export const DEFAULT_INPUT_PLACEHOLDER_ES = 'Escribe o / para comandos';

/**
 * Trunca el texto placeholder con "..." si no cabe en una sola línea en terminales angostas.
 */
export function formatInputPlaceholder(
  placeholderText: string,
  terminalColumns: number,
  promptPrefixLength = 16,
): string {
  const clean = placeholderText.replace(/[\r\n]+/g, ' ').trim();
  // Restamos bordes/paddings (6 columnas) y el largo del prefijo del prompt
  const available = Math.max(8, terminalColumns - promptPrefixLength - 6);
  if (clean.length <= available) {
    return clean;
  }
  const sliceLen = Math.max(1, available - 3);
  return `${clean.slice(0, sliceLen)}...`;
}

