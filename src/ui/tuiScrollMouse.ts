import { spawn } from 'node:child_process';
import { openExternalHttpUrl, writeTextToClipboard } from '../core/clipboard.js';
import type { SavedUiMessage } from '../core/sessionStore.js';
import { findLinkAtLineColumn, type RenderedLineLinkSpan } from './markdownTokens.js';

export const MIN_ROWS_FOR_HEADER = 12;

export const ENABLE_MOUSE_REPORTING = '\x1b[?1000h\x1b[?1006h\x1b[?1007h';
export const DISABLE_MOUSE_REPORTING = '\x1b[?1007l\x1b[?1006l\x1b[?1000l';
export const ENABLE_TERMINAL_FULL =
  '\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h';
export const DISABLE_TERMINAL_FULL =
  '\x1b[?1007l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h';

export function shouldShowHeaderForRows(rows: number): boolean {
  return rows >= MIN_ROWS_FOR_HEADER;
}

export interface ChatScrollState {
  scrollTop: number;
  isAtBottom: boolean;
}

export function computeEffectiveScrollTop(
  state: ChatScrollState,
  maxScrollTop: number,
): number {
  const safeMax = Math.max(0, maxScrollTop);
  if (state.isAtBottom) {
    return safeMax;
  }
  return Math.max(0, Math.min(state.scrollTop, safeMax));
}

export function scrollChatStateBy(
  state: ChatScrollState,
  deltaRows: number,
  maxScrollTop: number,
): ChatScrollState {
  const safeMax = Math.max(0, maxScrollTop);
  const currentTop = computeEffectiveScrollTop(state, safeMax);
  const nextTop = Math.max(0, Math.min(safeMax, currentTop + deltaRows));
  const isAtBottom = nextTop >= safeMax;
  return {
    scrollTop: nextTop,
    isAtBottom,
  };
}

export function scrollChatStateToBottom(maxScrollTop: number): ChatScrollState {
  return {
    scrollTop: Math.max(0, maxScrollTop),
    isAtBottom: true,
  };
}

export function shouldShowScrollToBottomButton(
  state: ChatScrollState,
  maxScrollTop: number,
): boolean {
  return !state.isAtBottom && maxScrollTop > 0;
}

export function formatScrollToBottomLabel(
  newMessagesCount = 0,
): string {
  if (newMessagesCount > 0) {
    return `ir al final (${newMessagesCount} ${newMessagesCount === 1 ? 'nuevo' : 'nuevos'})`;
  }
  return 'ir al final';
}

export interface ScrollbarThumbMetrics {
  trackHeight: number;
  thumbTop: number;
  thumbHeight: number;
  hasOverflow: boolean;
}

export function computeScrollbarThumb(params: {
  trackHeight: number;
  contentHeight: number;
  viewportHeight: number;
  scrollTop: number;
}): ScrollbarThumbMetrics {
  const trackHeight = Math.max(1, Math.floor(params.trackHeight));
  const contentHeight = Math.max(0, Math.floor(params.contentHeight));
  const viewportHeight = Math.max(1, Math.floor(params.viewportHeight));

  if (contentHeight <= viewportHeight) {
    return {
      trackHeight,
      thumbTop: 0,
      thumbHeight: trackHeight,
      hasOverflow: false,
    };
  }

  const thumbHeight = Math.max(
    1,
    Math.min(
      trackHeight,
      Math.round((viewportHeight / contentHeight) * trackHeight),
    ),
  );
  const maxScrollTop = Math.max(1, contentHeight - viewportHeight);
  const clampedScroll = Math.max(0, Math.min(maxScrollTop, params.scrollTop));
  const availableTrack = Math.max(0, trackHeight - thumbHeight);
  const thumbTop = Math.min(
    availableTrack,
    Math.max(0, Math.round((clampedScroll / maxScrollTop) * availableTrack)),
  );

  return {
    trackHeight,
    thumbTop,
    thumbHeight,
    hasOverflow: true,
  };
}

export function scrollTopFromScrollbarTrackRow(
  trackRowZeroBased: number,
  trackHeight: number,
  maxScrollTop: number,
): ChatScrollState {
  const safeTrack = Math.max(1, trackHeight - 1);
  const safeMax = Math.max(0, maxScrollTop);
  const ratio = Math.max(0, Math.min(1, trackRowZeroBased / safeTrack));
  const nextTop = Math.round(ratio * safeMax);
  return {
    scrollTop: nextTop,
    isAtBottom: nextTop >= safeMax,
  };
}

export interface SgrMouseEvent {
  cb: number;
  button: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  action: 'press' | 'release' | 'motion' | 'wheel';
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  wheelDeltaLines: number;
}

export function decodeSgrMousePacket(
  cb: number,
  x: number,
  y: number,
  terminator: 'M' | 'm',
): SgrMouseEvent {
  const ctrl = (cb & 16) !== 0;
  const shift = (cb & 4) !== 0;
  const alt = (cb & 8) !== 0;
  const isMotion = (cb & 32) !== 0;
  const isWheel = (cb & 64) !== 0;
  const button = (cb & 3) as 0 | 1 | 2 | 3;

  let wheelDeltaLines = 0;
  let action: SgrMouseEvent['action'] =
    terminator === 'M' ? 'press' : 'release';

  if (isWheel) {
    action = 'wheel';
    if (button === 0) {
      wheelDeltaLines = -3;
    } else if (button === 1) {
      wheelDeltaLines = 3;
    }
  } else if (isMotion) {
    action = 'motion';
  }

  return {
    cb,
    button,
    x,
    y,
    action,
    ctrl,
    shift,
    alt,
    wheelDeltaLines,
  };
}

export function parseMouseEventsFromChunk(rawChunk: string): {
  wheelDeltaLines: number;
  rightClickPaste: boolean;
  events: SgrMouseEvent[];
} {
  let wheelDeltaLines = 0;
  let rightClickPaste = false;
  const events: SgrMouseEvent[] = [];

  if (!rawChunk || !rawChunk.includes('\x1b[')) {
    return { wheelDeltaLines, rightClickPaste, events };
  }

  const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let match: RegExpExecArray | null;
  while ((match = sgrRegex.exec(rawChunk)) !== null) {
    const cb = Number.parseInt(match[1] ?? '0', 10);
    const x = Number.parseInt(match[2] ?? '1', 10);
    const y = Number.parseInt(match[3] ?? '1', 10);
    const kind = (match[4] === 'm' ? 'm' : 'M') as 'M' | 'm';
    const ev = decodeSgrMousePacket(cb, x, y, kind);
    events.push(ev);
    if (ev.action === 'wheel') {
      wheelDeltaLines += ev.wheelDeltaLines;
    } else if (ev.button === 2 && ev.action === 'press' && !ev.ctrl) {
      rightClickPaste = true;
    }
  }

  const x10Regex = /\x1b\[M([\s\S]{3})/g;
  while ((match = x10Regex.exec(rawChunk)) !== null) {
    const seq = match[1];
    if (seq && seq.length >= 1) {
      const cb = seq.charCodeAt(0) - 32;
      if ((cb & 64) !== 0) {
        if ((cb & 3) === 0) {
          wheelDeltaLines -= 3;
        } else if ((cb & 3) === 1) {
          wheelDeltaLines += 3;
        }
      }
    }
  }

  return { wheelDeltaLines, rightClickPaste, events };
}

export function parseMouseWheelSequences(rawChunk: string): {
  wheelDeltaLines: number;
  rightClickPaste: boolean;
} {
  const { wheelDeltaLines, rightClickPaste } =
    parseMouseEventsFromChunk(rawChunk);
  return { wheelDeltaLines, rightClickPaste };
}

export function readTerminalSize(stream?: NodeJS.WritableStream): {
  columns: number;
  rows: number;
} {
  const ws = stream as NodeJS.WriteStream | undefined;
  const cols =
    (ws && typeof ws.columns === 'number' && ws.columns > 0
      ? ws.columns
      : undefined) ??
    (typeof process.stdout.columns === 'number' && process.stdout.columns > 0
      ? process.stdout.columns
      : 100);
  const rows =
    (ws && typeof ws.rows === 'number' && ws.rows > 0
      ? ws.rows
      : undefined) ??
    (typeof process.stdout.rows === 'number' && process.stdout.rows > 0
      ? process.stdout.rows
      : 24);
  return { columns: cols, rows };
}

export interface QueueDragLayoutParams {
  rows: number;
  queueLength: number;
  visibleInputBoxLines?: number;
  slashSuggestionsCount?: number;
}

export function computeQueueItemBoundsY(params: QueueDragLayoutParams): {
  firstItemY: number;
  lastItemY: number;
} {
  const inputBoxLinesWithBorder = Math.max(1, params.visibleInputBoxLines ?? 1) + 2;
  const slashRows =
    params.slashSuggestionsCount && params.slashSuggestionsCount > 0
      ? params.slashSuggestionsCount + 1
      : 0;
  // StatusBarBottom (1 línea en rows) + InputBox (visible + 2) + slashRows + marginBottom de queue (1)
  const lastItemY = params.rows - 1 - inputBoxLinesWithBorder - slashRows - 1;
  const firstItemY = lastItemY - Math.max(0, params.queueLength - 1);
  return { firstItemY, lastItemY };
}

export function resolveQueueItemIndexAtMouseY(
  mouseY: number,
  params: QueueDragLayoutParams,
  clampOutsideBounds = false,
): number | null {
  if (params.queueLength <= 0) return null;
  const { firstItemY, lastItemY } = computeQueueItemBoundsY(params);
  if (clampOutsideBounds) {
    return Math.max(
      0,
      Math.min(params.queueLength - 1, mouseY - firstItemY),
    );
  }
  if (mouseY < firstItemY || mouseY > lastItemY) {
    return null;
  }
  return mouseY - firstItemY;
}

export interface SgrMouseDispatchParams {
  events: readonly SgrMouseEvent[];
  columns: number;
  rows: number;
  lineLinkMap: ReadonlyMap<number, readonly RenderedLineLinkSpan[]>;
  messages: readonly SavedUiMessage[];
  isAtBottom: boolean;
  readMaxScrollTop: () => number;
  updateScrollState: (next: ChatScrollState) => void;
  showTransientNotice: (msg: string) => void;
  setThoughtsCollapsed: React.Dispatch<React.SetStateAction<boolean | null>>;
  setCopiedMessageId: (id: string) => void;
  togglePerMessageCollapsed: (id: string) => void;
  onOpenAgentsPanel?: () => void;
  onToggleShortcuts?: () => void;
  onOpenModelDialog?: () => void;
  onOpenUsageDialog?: () => void;
  onOpenSettingsDialog?: () => void;
  queueLength?: number;
  visibleInputBoxLines?: number;
  slashSuggestionsCount?: number;
  draggingQueueIdx?: number | null;
  onStartQueueDrag?: (idx: number) => void;
  onMoveQueueDrag?: (targetIdx: number) => void;
  onEndQueueDrag?: () => void;
}

export function dispatchSgrMouseEvents(params: SgrMouseDispatchParams): void {
  const { events, columns, rows, lineLinkMap } = params;
  const queueLen = params.queueLength ?? 0;
  let activeDragIdx = params.draggingQueueIdx ?? null;

  for (const ev of events) {
    if (queueLen > 0 && activeDragIdx !== null) {
      if (ev.action === 'motion' && ev.button === 0) {
        const targetIdx = resolveQueueItemIndexAtMouseY(
          ev.y,
          {
            rows,
            queueLength: queueLen,
            visibleInputBoxLines: params.visibleInputBoxLines,
            slashSuggestionsCount: params.slashSuggestionsCount,
          },
          true,
        );
        if (targetIdx !== null && targetIdx !== activeDragIdx) {
          activeDragIdx = targetIdx;
          params.onMoveQueueDrag?.(targetIdx);
        }
        continue;
      }
      if (ev.action === 'release') {
        const targetIdx = resolveQueueItemIndexAtMouseY(
          ev.y,
          {
            rows,
            queueLength: queueLen,
            visibleInputBoxLines: params.visibleInputBoxLines,
            slashSuggestionsCount: params.slashSuggestionsCount,
          },
          true,
        );
        if (targetIdx !== null && targetIdx !== activeDragIdx) {
          params.onMoveQueueDrag?.(targetIdx);
        }
        activeDragIdx = null;
        params.onEndQueueDrag?.();
        continue;
      }
    }

    if (
      queueLen > 0 &&
      ev.button === 0 &&
      ev.action === 'press' &&
      ev.x < columns - 2
    ) {
      const clickedQueueIdx = resolveQueueItemIndexAtMouseY(
        ev.y,
        {
          rows,
          queueLength: queueLen,
          visibleInputBoxLines: params.visibleInputBoxLines,
          slashSuggestionsCount: params.slashSuggestionsCount,
        },
        false,
      );
      if (clickedQueueIdx !== null) {
        activeDragIdx = clickedQueueIdx;
        params.onStartQueueDrag?.(clickedQueueIdx);
        continue;
      }
    }

    if (ev.ctrl && ev.action === 'press') {
      for (const [lineIdx] of lineLinkMap.entries()) {
        const foundUrl =
          findLinkAtLineColumn(lineLinkMap, lineIdx, ev.x) ??
          findLinkAtLineColumn(lineLinkMap, lineIdx);
        if (foundUrl) {
          if (ev.button === 0) {
            openExternalHttpUrl(foundUrl);
          } else if (ev.button === 2) {
            writeTextToClipboard(foundUrl);
            params.showTransientNotice('link copiado');
          }
          return;
        }
      }
    }
    if (ev.button === 0 && (ev.action === 'press' || ev.action === 'motion')) {
      const headerRows = shouldShowHeaderForRows(rows) ? 4 : 0;
      const trackH = Math.max(1, rows - headerRows - 6);
      if (
        ev.x >= columns - 2 &&
        ev.y > headerRows &&
        ev.y <= headerRows + trackH
      ) {
        const trackRow = ev.y - headerRows - 1;
        params.updateScrollState(
          scrollTopFromScrollbarTrackRow(
            trackRow,
            trackH,
            params.readMaxScrollTop(),
          ),
        );
        return;
      }
      if (ev.action === 'press') {
        if (
          !params.isAtBottom &&
          ev.y >= headerRows + trackH - 1 &&
          ev.y <= headerRows + trackH + 1
        ) {
          params.updateScrollState(
            scrollChatStateToBottom(params.readMaxScrollTop()),
          );
          return;
        }
        // Barra inferior: [Agentes] | [? = atajos] | [Modelo | Esfuerzo]
        if (ev.y >= rows - 1) {
          if (ev.x <= 18 && params.onOpenAgentsPanel) {
            params.onOpenAgentsPanel();
            return;
          }
          if (ev.x > 18 && ev.x <= 34 && params.onToggleShortcuts) {
            params.onToggleShortcuts();
            return;
          }
          if (ev.x >= columns - 38 && params.onOpenModelDialog) {
            params.onOpenModelDialog();
            return;
          }
        }
        // Zona StatusBarTop encima del cuadro de texto
        if (ev.y >= rows - 5 && ev.y <= rows - 3) {
          if (ev.x <= 28 || ev.x >= columns - 26) {
            if (ev.x <= 28) {
              params.setThoughtsCollapsed((prev) => (prev === null ? true : !prev));
              return;
            }
          }
          if (ev.y === rows - 5 && ev.x >= columns - 44 && params.onOpenUsageDialog) {
            params.onOpenUsageDialog();
            return;
          }
          if (ev.y === rows - 4 && ev.x >= columns - 48 && params.onOpenSettingsDialog) {
            params.onOpenSettingsDialog();
            return;
          }
          if (ev.x >= columns - 26) {
            params.setThoughtsCollapsed((prev) => (prev === null ? true : !prev));
            return;
          }
        }
        const lastMsg = params.messages
          .filter((m) => m.role === 'model' || m.role === 'user')
          .at(-1);
        if (
          lastMsg &&
          ev.x >= columns - 16 &&
          ev.y > headerRows &&
          ev.y < rows - 4
        ) {
          writeTextToClipboard(lastMsg.text);
          params.setCopiedMessageId(lastMsg.id);
          return;
        }
        if (
          lastMsg &&
          lastMsg.thoughtText &&
          ev.x >= columns - 40 &&
          ev.x < columns - 16 &&
          ev.y > headerRows &&
          ev.y < rows - 4
        ) {
          params.togglePerMessageCollapsed(lastMsg.id);
          return;
        }
      }
    }
  }
}

export function notifyUserForQuestion(question: string, header?: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write('\x07');
  }
  if (process.platform === 'win32') {
    try {
      const safeTitle = (header || 'Glitch CLI - Pregunta de la IA')
        .replace(/['"`$]/g, '')
        .slice(0, 60);
      const safeBody = question.replace(/['"`$\r\n]/g, ' ').slice(0, 180);
      const psScript = `try { [console]::beep(880,300) } catch {}; try { Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle = '${safeTitle}'; $n.BalloonTipText = '${safeBody}'; $n.Visible = $true; $n.ShowBalloonTip(5000); Start-Sleep -Milliseconds 1500; $n.Dispose() } catch {}`;
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.unref();
    } catch {
      // Ignora si PowerShell no está disponible
    }
  }
}
