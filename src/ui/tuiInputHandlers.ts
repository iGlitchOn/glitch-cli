import type { Key } from 'ink';
import type { SlashCommandEntry } from '../commands/slashRegistry.js';
import type { GlitchSettings, SubMode } from '../config/settings.js';
import {
  InputUndoManager,
  deleteBackwardAtCursor,
  deleteForwardAtCursor,
  deleteWordBackwardAtCursor,
  insertTextAtCursor,
  moveCursorEnd,
  moveCursorHome,
  moveCursorLeft,
  moveCursorRight,
  reorderQueueItem,
  type LineEditorState,
} from '../core/lineEditor.js';
import type { SessionState } from '../core/session.js';
import { listSavedSessions, type SavedSession } from '../core/sessionStore.js';
import { toggleSubMode } from '../permissions/permissions.js';
import type { ActiveDialog } from './DialogsView.js';
import { wrapInputTextIntoVisualLines } from './InputBoxView.js';
export * from './tuiCommandDispatcher.js';
export * from './tuiDialogKeys.js';
export interface MainInputKeyContext {
  inputText: string;
  inputCursor: number;
  isStreaming: boolean;
  editingQueueIdx: number | null;
  confirmDeleteQueueIdx: number | null;
  matchingSlash: readonly SlashCommandEntry[];
  suggestionIdx: number;
  showShortcutsPanel: boolean;
  session: SessionState;
  queueRef: React.MutableRefObject<string[]>;
  draftInputRef: React.MutableRefObject<string>;
  originalEditingQueueTextRef: React.MutableRefObject<string>;
  inputStateRef: React.MutableRefObject<LineEditorState>;
  inputUndoManager: InputUndoManager;
  abortCurrentTurn: () => void;
  syncQueueState: () => void;
  setConfirmDeleteQueueIdx: (idx: number | null) => void;
  setEditingQueueIdx: (idx: number | null) => void;
  setFullInputText: (text: string) => void;
  applyInputState: (next: LineEditorState) => void;
  syncSettings: (next: GlitchSettings) => void;
  setThoughtsCollapsed: React.Dispatch<React.SetStateAction<boolean | null>>;
  selectionMode?: boolean;
  setSelectionMode?: React.Dispatch<React.SetStateAction<boolean>>;
  openAgentsPanel: (saved: SavedSession[]) => void;
  setShowShortcutsPanel: React.Dispatch<React.SetStateAction<boolean>>;
  setSuggestionIdx: React.Dispatch<React.SetStateAction<number>>;
  executeInputCommand: (raw: string) => void;
  handlePastedTextBlock: (raw: string) => void;
}
export function handleMainEditorKeyInput(
  input: string,
  key: Key,
  ctx: MainInputKeyContext,
): void {
  const lowerInput = input.toLowerCase();
  if ((key.ctrl && lowerInput === 's') || input === '\x13') {
    ctx.setSelectionMode?.((prev) => !prev);
    return;
  }
  if (key.escape && ctx.selectionMode) {
    ctx.setSelectionMode?.(false);
    return;
  }
  if (ctx.confirmDeleteQueueIdx !== null) {
    if (key.return || lowerInput === 's' || lowerInput === 'y') {
      ctx.queueRef.current.splice(ctx.confirmDeleteQueueIdx, 1);
      ctx.syncQueueState();
      ctx.setConfirmDeleteQueueIdx(null);
      ctx.setEditingQueueIdx(null);
      ctx.setFullInputText(ctx.draftInputRef.current);
      ctx.draftInputRef.current = '';
    } else if (key.escape || lowerInput === 'n') {
      ctx.setConfirmDeleteQueueIdx(null);
      ctx.setFullInputText(ctx.originalEditingQueueTextRef.current);
    }
    return;
  }
  if (
    key.escape &&
    (ctx.isStreaming ||
      ctx.session.isRequestActive ||
      ctx.editingQueueIdx !== null)
  ) {
    if (ctx.editingQueueIdx !== null) {
      const beforeState = { text: ctx.inputText, cursor: ctx.inputCursor };
      ctx.setEditingQueueIdx(null);
      const nextState = {
        text: ctx.draftInputRef.current,
        cursor: ctx.draftInputRef.current.length,
      };
      ctx.inputUndoManager.recordEdit(beforeState, nextState, 'load_queue');
      ctx.applyInputState(nextState);
    }
    if (ctx.isStreaming || ctx.session.isRequestActive) {
      ctx.abortCurrentTurn();
    }
    return;
  }
  if ((key.tab && key.shift) || (key.meta && lowerInput === 'p')) {
    const nextSubMode: SubMode = toggleSubMode(ctx.session.settings.subMode);
    ctx.syncSettings({ ...ctx.session.settings, subMode: nextSubMode });
    return;
  }
  if ((key.ctrl || key.meta) && lowerInput === 't') {
    ctx.setThoughtsCollapsed((prev) =>
      prev === null
        ? (ctx.session.settings.thinkingDisplay ?? 'expandido') === 'contraido'
          ? false
          : true
        : !prev,
    );
    return;
  }
  if (
    ctx.editingQueueIdx === null &&
    ctx.inputText.length === 0 &&
    (key.leftArrow || input === '<')
  ) {
    ctx.openAgentsPanel(listSavedSessions());
    return;
  }
  if (ctx.inputText.length === 0 && input === '?' && !key.ctrl && !key.meta) {
    ctx.setShowShortcutsPanel((prev) => !prev);
    return;
  }
  if (ctx.matchingSlash.length > 0) {
    if (key.upArrow) {
      ctx.setSuggestionIdx((prev) =>
        prev > 0 ? prev - 1 : ctx.matchingSlash.length - 1,
      );
      return;
    }
    if (key.downArrow) {
      ctx.setSuggestionIdx((prev) =>
        prev < ctx.matchingSlash.length - 1 ? prev + 1 : 0,
      );
      return;
    }
    if (key.tab) {
      const chosen =
        ctx.matchingSlash[ctx.suggestionIdx] ?? ctx.matchingSlash[0];
      if (chosen) {
        ctx.setFullInputText(chosen.displayCmd + ' ');
        ctx.setSuggestionIdx(0);
      }
      return;
    }
  }
  if (
    ctx.matchingSlash.length === 0 &&
    ctx.queueRef.current.length > 1 &&
    (key.meta || key.shift || key.ctrl) &&
    (key.upArrow || key.downArrow)
  ) {
    const q = ctx.queueRef.current;
    const fromIdx =
      ctx.editingQueueIdx !== null ? ctx.editingQueueIdx : q.length - 1;
    const toIdx = key.upArrow
      ? Math.max(0, fromIdx - 1)
      : Math.min(q.length - 1, fromIdx + 1);
    if (ctx.editingQueueIdx === null) {
      ctx.draftInputRef.current = ctx.inputText;
      const fullQueueText = q[fromIdx] ?? '';
      ctx.originalEditingQueueTextRef.current = fullQueueText;
      ctx.applyInputState({
        text: fullQueueText,
        cursor: fullQueueText.length,
      });
    }
    const res = reorderQueueItem(q, fromIdx, toIdx, fromIdx);
    if (res.moved) {
      ctx.queueRef.current = res.queue;
      ctx.syncQueueState();
      ctx.setEditingQueueIdx(res.nextEditingIdx);
    } else if (ctx.editingQueueIdx === null) {
      ctx.setEditingQueueIdx(fromIdx);
    }
    return;
  }
  if (
    ctx.matchingSlash.length === 0 &&
    ctx.inputText.length > 0 &&
    (key.upArrow || key.downArrow)
  ) {
    const promptPrefixLen =
      ctx.editingQueueIdx !== null
        ? `[Cola #${ctx.editingQueueIdx + 1}] > `.length
        : 2;
    const cols = process.stdout.columns ?? 100;
    const textLineWidth = Math.max(12, cols - promptPrefixLen - 8);
    const visualLines = wrapInputTextIntoVisualLines(
      ctx.inputText,
      textLineWidth,
    );
    if (visualLines.length > 1) {
      const safeCursor = Math.max(
        0,
        Math.min(ctx.inputCursor, ctx.inputText.length),
      );
      let curIdx = visualLines.length - 1;
      for (let i = 0; i < visualLines.length; i++) {
        const vl = visualLines[i]!;
        const isLast = i === visualLines.length - 1;
        if (
          safeCursor >= vl.start &&
          (safeCursor < vl.end || (isLast && safeCursor <= vl.end))
        ) {
          curIdx = i;
          break;
        }
      }
      const colOffset = Math.max(0, safeCursor - visualLines[curIdx]!.start);
      if (key.upArrow && curIdx > 0) {
        const prevLine = visualLines[curIdx - 1]!;
        const maxEnd =
          prevLine.end > prevLine.start && prevLine.text.endsWith(' ')
            ? prevLine.end - 1
            : prevLine.end;
        const nextCursor = Math.min(prevLine.start + colOffset, maxEnd);
        ctx.inputUndoManager.breakGroup();
        ctx.applyInputState({ text: ctx.inputText, cursor: nextCursor });
        return;
      }
      if (key.downArrow && curIdx < visualLines.length - 1) {
        const nextLine = visualLines[curIdx + 1]!;
        const isNextLast = curIdx + 1 === visualLines.length - 1;
        const maxEnd =
          !isNextLast &&
          nextLine.end > nextLine.start &&
          nextLine.text.endsWith(' ')
            ? nextLine.end - 1
            : nextLine.end;
        const nextCursor = Math.min(nextLine.start + colOffset, maxEnd);
        ctx.inputUndoManager.breakGroup();
        ctx.applyInputState({ text: ctx.inputText, cursor: nextCursor });
        return;
      }
    }
  }
  if (ctx.matchingSlash.length === 0 && ctx.queueRef.current.length > 0) {
    if (key.upArrow) {
      const q = ctx.queueRef.current;
      const beforeState = { text: ctx.inputText, cursor: ctx.inputCursor };
      const targetIdx =
        ctx.editingQueueIdx === null
          ? q.length - 1
          : Math.max(0, ctx.editingQueueIdx - 1);
      if (ctx.editingQueueIdx === null) {
        ctx.draftInputRef.current = ctx.inputText;
      }
      const fullQueueText = q[targetIdx] ?? '';
      ctx.originalEditingQueueTextRef.current = fullQueueText;
      ctx.setEditingQueueIdx(targetIdx);
      const nextState = { text: fullQueueText, cursor: fullQueueText.length };
      ctx.inputUndoManager.recordEdit(beforeState, nextState, 'load_queue');
      ctx.applyInputState(nextState);
      return;
    }
    if (key.downArrow && ctx.editingQueueIdx !== null) {
      const q = ctx.queueRef.current;
      const beforeState = { text: ctx.inputText, cursor: ctx.inputCursor };
      if (ctx.editingQueueIdx < q.length - 1) {
        const targetIdx = ctx.editingQueueIdx + 1;
        const fullQueueText = q[targetIdx] ?? '';
        ctx.originalEditingQueueTextRef.current = fullQueueText;
        ctx.setEditingQueueIdx(targetIdx);
        const nextState = { text: fullQueueText, cursor: fullQueueText.length };
        ctx.inputUndoManager.recordEdit(beforeState, nextState, 'load_queue');
        ctx.applyInputState(nextState);
      } else {
        ctx.setEditingQueueIdx(null);
        const nextState = {
          text: ctx.draftInputRef.current,
          cursor: ctx.draftInputRef.current.length,
        };
        ctx.inputUndoManager.recordEdit(beforeState, nextState, 'load_queue');
        ctx.applyInputState(nextState);
      }
      return;
    }
    if (key.escape && ctx.editingQueueIdx !== null) {
      const beforeState = { text: ctx.inputText, cursor: ctx.inputCursor };
      ctx.setEditingQueueIdx(null);
      const nextState = {
        text: ctx.draftInputRef.current,
        cursor: ctx.draftInputRef.current.length,
      };
      ctx.inputUndoManager.recordEdit(beforeState, nextState, 'load_queue');
      ctx.applyInputState(nextState);
      return;
    }
  }
  if (key.leftArrow && ctx.inputText.length > 0) {
    ctx.inputUndoManager.breakGroup();
    ctx.applyInputState(
      moveCursorLeft(
        { text: ctx.inputText, cursor: ctx.inputCursor },
        key.ctrl || key.meta,
      ),
    );
    return;
  }
  if (key.rightArrow && ctx.inputText.length > 0) {
    ctx.inputUndoManager.breakGroup();
    ctx.applyInputState(
      moveCursorRight(
        { text: ctx.inputText, cursor: ctx.inputCursor },
        key.ctrl || key.meta,
      ),
    );
    return;
  }
  if (key.home || (key.ctrl && lowerInput === 'a')) {
    ctx.inputUndoManager.breakGroup();
    ctx.applyInputState(
      moveCursorHome({ text: ctx.inputText, cursor: ctx.inputCursor }),
    );
    return;
  }
  if (key.end || (key.ctrl && lowerInput === 'e')) {
    ctx.inputUndoManager.breakGroup();
    ctx.applyInputState(
      moveCursorEnd({ text: ctx.inputText, cursor: ctx.inputCursor }),
    );
    return;
  }
  if (key.return) {
    if (
      ctx.editingQueueIdx !== null &&
      ctx.editingQueueIdx < ctx.queueRef.current.length
    ) {
      const edited = ctx.inputText.trim();
      if (!edited) {
        ctx.setConfirmDeleteQueueIdx(ctx.editingQueueIdx);
        return;
      }
      ctx.queueRef.current[ctx.editingQueueIdx] = edited;
      ctx.syncQueueState();
      ctx.setEditingQueueIdx(null);
      ctx.setFullInputText(ctx.draftInputRef.current);
      ctx.draftInputRef.current = '';
      ctx.inputUndoManager.clear();
      return;
    }
    const val = ctx.inputText;
    ctx.setFullInputText('');
    ctx.setSuggestionIdx(0);
    ctx.inputUndoManager.clear();
    ctx.executeInputCommand(val);
    return;
  }
  if (
    ((key.backspace || key.delete) && (key.shift || key.ctrl || key.meta)) ||
    (key.ctrl && lowerInput === 'w')
  ) {
    const beforeState = ctx.inputStateRef.current;
    const nextState = deleteWordBackwardAtCursor(beforeState);
    ctx.inputUndoManager.recordEdit(beforeState, nextState, 'delete_word');
    ctx.applyInputState(nextState);
    if (ctx.suggestionIdx !== 0) ctx.setSuggestionIdx(0);
    return;
  }
  if (key.backspace || key.delete) {
    const beforeState = ctx.inputStateRef.current;
    const nextState = key.backspace
      ? deleteBackwardAtCursor(beforeState)
      : deleteForwardAtCursor(beforeState);
    ctx.inputUndoManager.recordEdit(beforeState, nextState, 'delete_char');
    ctx.applyInputState(nextState);
    if (ctx.suggestionIdx !== 0) ctx.setSuggestionIdx(0);
    return;
  }
  if (input && !key.ctrl && !key.meta) {
    if (ctx.showShortcutsPanel) ctx.setShowShortcutsPanel(false);
    if (input.length > 1 || input.includes('\r') || input.includes('\n')) {
      ctx.handlePastedTextBlock(input);
      return;
    }
    const beforeState = ctx.inputStateRef.current;
    const nextState = insertTextAtCursor(beforeState, input);
    ctx.inputUndoManager.recordEdit(
      beforeState,
      nextState,
      'type_char',
      input,
      Date.now(),
    );
    ctx.applyInputState(nextState);
    if (ctx.suggestionIdx !== 0) ctx.setSuggestionIdx(0);
  }
}
