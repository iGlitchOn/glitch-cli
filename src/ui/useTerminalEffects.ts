import { useEffect, useRef } from 'react';
import { isAuthConfigured, type GlitchSettings } from '../config/settings.js';
import type { InputUndoManager, LineEditorState } from '../core/lineEditor.js';
import {
  DISABLE_MOUSE_REPORTING,
  DISABLE_TERMINAL_FULL,
  ENABLE_MOUSE_REPORTING,
  ENABLE_TERMINAL_FULL,
  parseMouseEventsFromChunk,
  readTerminalSize,
  type SgrMouseEvent,
} from './tuiScrollMouse.js';

export interface UseTerminalEffectsParams {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  initialSettings: GlitchSettings;
  daaSplashSeconds: number;
  isStreaming: boolean;
  ctrlCPending: boolean;
  selectionMode: boolean;
  streamStartTimeRef: React.MutableRefObject<number>;
  inputUndoManagerRef: React.MutableRefObject<InputUndoManager>;
  inputStateRef: React.MutableRefObject<LineEditorState>;
  setDaaSplashSeconds: React.Dispatch<React.SetStateAction<number>>;
  addSystemMessage: (msg: string) => void;
  setStreamingElapsedMs: React.Dispatch<React.SetStateAction<number>>;
  setCtrlCPending: React.Dispatch<React.SetStateAction<boolean>>;
  refreshModels: (cfg: GlitchSettings) => Promise<void>;
  applyInputState: (next: LineEditorState) => void;
  setTermSize: React.Dispatch<
    React.SetStateAction<{ columns: number; rows: number }>
  >;
  scrollChatBy: (deltaLines: number) => void;
  handleClipboardPaste: () => void;
  onSgrMouseEvents?: (events: SgrMouseEvent[]) => void;
  initialPrompt?: string;
  onInitialPrompt?: (prompt: string) => void;
}

export function useTerminalEffects({
  stdout,
  stdin,
  initialSettings,
  daaSplashSeconds,
  isStreaming,
  ctrlCPending,
  selectionMode,
  streamStartTimeRef,
  inputUndoManagerRef,
  inputStateRef,
  setDaaSplashSeconds,
  addSystemMessage,
  setStreamingElapsedMs,
  setCtrlCPending,
  refreshModels,
  applyInputState,
  setTermSize,
  scrollChatBy,
  handleClipboardPaste,
  onSgrMouseEvents,
  initialPrompt,
  onInitialPrompt,
}: UseTerminalEffectsParams): void {
  const initialPromptDispatchedRef = useRef(false);

  useEffect(() => {
    if (daaSplashSeconds > 0 || initialPromptDispatchedRef.current) return;
    const cleanPrompt = initialPrompt?.trim();
    if (!cleanPrompt) return;
    initialPromptDispatchedRef.current = true;
    onInitialPrompt?.(cleanPrompt);
  }, [daaSplashSeconds, initialPrompt]);
  useEffect(() => {
    if (daaSplashSeconds <= 0) return;
    const timer = setTimeout(() => {
      if (daaSplashSeconds === 1) {
        setDaaSplashSeconds(0);
        addSystemMessage(
          'Flag --DAA activa: si quieres desactivar este mensaje inicial de 3 segundos, configúralo en /ajustes (Advertencia --DAA al inicio: OFF).',
        );
      } else {
        setDaaSplashSeconds((prev) => prev - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [daaSplashSeconds]);

  useEffect(() => {
    if (!isStreaming) {
      setStreamingElapsedMs(0);
      return;
    }
    const interval = setInterval(() => {
      setStreamingElapsedMs(Date.now() - streamStartTimeRef.current);
    }, 1000);
    return () => clearInterval(interval);
  }, [isStreaming]);

  useEffect(() => {
    if (!ctrlCPending) return;
    const timer = setTimeout(() => setCtrlCPending(false), 3000);
    return () => clearTimeout(timer);
  }, [ctrlCPending]);

  useEffect(() => {
    if (isAuthConfigured(initialSettings)) {
      void refreshModels(initialSettings);
    }
  }, []);

  useEffect(() => {
    const handleSigTstp = () => {
      const restored = inputUndoManagerRef.current.undo(inputStateRef.current);
      if (restored) applyInputState(restored);
    };
    process.on('SIGTSTP', handleSigTstp);
    return () => {
      process.off('SIGTSTP', handleSigTstp);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const nextSize = readTerminalSize(stdout);
      setTermSize((prev) =>
        prev.columns === nextSize.columns && prev.rows === nextSize.rows
          ? prev
          : nextSize,
      );
    };
    stdout.on('resize', handleResize);
    if (process.stdout !== stdout) {
      process.stdout.on('resize', handleResize);
    }
    handleResize();
    return () => {
      stdout.off('resize', handleResize);
      if (process.stdout !== stdout) {
        process.stdout.off('resize', handleResize);
      }
    };
  }, [stdout]);

  // Modo selección (Ctrl+S): apaga solo 1000, 1006 y 1007 dejando pantalla alterna (1049) y pegado entre corchetes (2004)
  useEffect(() => {
    const isTty = Boolean(stdout.isTTY || process.stdout.isTTY);
    if (!isTty) return;
    try {
      stdout.write(
        selectionMode ? DISABLE_MOUSE_REPORTING : ENABLE_MOUSE_REPORTING,
      );
    } catch {
      // Ignorar
    }
  }, [selectionMode, stdout]);

  useEffect(() => {
    const isTty = Boolean(stdout.isTTY || process.stdout.isTTY);
    const restoreTerminal = () => {
      if (!isTty) return;
      try {
        stdout.write(DISABLE_TERMINAL_FULL);
      } catch {
        // Ignorar
      }
    };
    if (isTty) {
      try {
        stdout.write(ENABLE_TERMINAL_FULL);
      } catch {
        // Ignorar
      }
    }
    const origRead = stdin.read.bind(stdin);
    const wrappedRead = ((size?: number) => {
      const chunk = origRead(size);
      if (chunk !== null && chunk !== undefined) {
        const rawStr =
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : String(chunk);
        const { wheelDeltaLines, rightClickPaste, events } =
          parseMouseEventsFromChunk(rawStr);
        if (wheelDeltaLines !== 0) scrollChatBy(wheelDeltaLines);
        if (rightClickPaste) handleClipboardPaste();
        if (events.length > 0) {
          onSgrMouseEvents?.(events);
        }
        if (
          rawStr === '\x08' ||
          rawStr === '\x1b[27;2;127~' ||
          rawStr === '\x1b[27;2;8~' ||
          rawStr === '\x1b[127;2~' ||
          rawStr === '\x1b[8;2u'
        ) {
          return (
            typeof chunk === 'string'
              ? '\x1b\x7f'
              : Buffer.from('\x1b\x7f', 'utf8')
          ) as ReturnType<typeof origRead>;
        }
      }
      return chunk;
    }) as typeof stdin.read;
    stdin.read = wrappedRead;
    process.on('exit', restoreTerminal);
    return () => {
      if (stdin.read === wrappedRead) stdin.read = origRead;
      process.off('exit', restoreTerminal);
      restoreTerminal();
    };
  }, [stdout, stdin]);
}
