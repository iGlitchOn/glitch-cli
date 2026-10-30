import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Content } from '@google/genai';
import type { ProviderAdapter } from '../providers/types.js';
import type { CostRequestRecord } from '../ui/statusBar.js';

export interface SavedUiMessage {
  id: string;
  role: 'user' | 'model' | 'system';
  text: string;
  thoughtText?: string;
  subthinking?: string;
  blockTitle?: string;
  isBlockSummary?: boolean;
  isUsageReport?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolDurationMs?: number;
  toolStatus?: 'en vivo' | 'listo' | 'error' | 'cancelado';
  timestamp?: string;
  durationText?: string;
}

export interface SavedSession {
  id: string;
  title: string;
  customTitle?: string;
  completedTurnsCount?: number;
  titleGeneratedAtTurn?: number;
  createdAt: string;
  updatedAt: string;
  model: string;
  effort: string;
  history: Content[];
  messages: SavedUiMessage[];
  sessionCostUsd?: number | null;
  costRecords?: CostRequestRecord[];
  lastApiPromptTokens?: number | null;
}

export interface GlobalUsageStats {
  totalCostUsd: number;
  totalRequests: number;
  unknownPriceRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalReasoningTokens: number;
  updatedAt: string;
}

export function getSessionsDir(customHomeDir?: string): string {
  const home = customHomeDir ?? os.homedir();
  return path.join(home, '.glitch', 'sessions');
}

export function getGlobalUsagePath(customHomeDir?: string): string {
  const home = customHomeDir ?? os.homedir();
  return path.join(home, '.glitch', 'usage.json');
}

export function createDefaultGlobalUsage(): GlobalUsageStats {
  return {
    totalCostUsd: 0,
    totalRequests: 0,
    unknownPriceRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    totalReasoningTokens: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function loadGlobalUsage(customHomeDir?: string): GlobalUsageStats {
  const filePath = getGlobalUsagePath(customHomeDir);
  if (!fs.existsSync(filePath)) {
    return createDefaultGlobalUsage();
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GlobalUsageStats>;
    if (!parsed || typeof parsed !== 'object') {
      return createDefaultGlobalUsage();
    }
    return {
      totalCostUsd:
        typeof parsed.totalCostUsd === 'number' &&
        !Number.isNaN(parsed.totalCostUsd)
          ? Math.max(0, parsed.totalCostUsd)
          : 0,
      totalRequests:
        typeof parsed.totalRequests === 'number' &&
        !Number.isNaN(parsed.totalRequests)
          ? Math.max(0, Math.floor(parsed.totalRequests))
          : 0,
      unknownPriceRequests:
        typeof parsed.unknownPriceRequests === 'number' &&
        !Number.isNaN(parsed.unknownPriceRequests)
          ? Math.max(0, Math.floor(parsed.unknownPriceRequests))
          : 0,
      totalInputTokens:
        typeof parsed.totalInputTokens === 'number' &&
        !Number.isNaN(parsed.totalInputTokens)
          ? Math.max(0, Math.floor(parsed.totalInputTokens))
          : 0,
      totalOutputTokens:
        typeof parsed.totalOutputTokens === 'number' &&
        !Number.isNaN(parsed.totalOutputTokens)
          ? Math.max(0, Math.floor(parsed.totalOutputTokens))
          : 0,
      totalCachedTokens:
        typeof parsed.totalCachedTokens === 'number' &&
        !Number.isNaN(parsed.totalCachedTokens)
          ? Math.max(0, Math.floor(parsed.totalCachedTokens))
          : 0,
      totalReasoningTokens:
        typeof parsed.totalReasoningTokens === 'number' &&
        !Number.isNaN(parsed.totalReasoningTokens)
          ? Math.max(0, Math.floor(parsed.totalReasoningTokens))
          : 0,
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return createDefaultGlobalUsage();
  }
}

export function saveGlobalUsage(
  stats: GlobalUsageStats,
  customHomeDir?: string,
): void {
  const filePath = getGlobalUsagePath(customHomeDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`;
  const payload = JSON.stringify(stats, null, 2);
  fs.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, payload, { encoding: 'utf-8', mode: 0o600 });
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignorar
      }
    }
  }
}

export function recordRequestInGlobalUsage(
  rec: CostRequestRecord,
  customHomeDir?: string,
): GlobalUsageStats {
  const current = loadGlobalUsage(customHomeDir);
  const next: GlobalUsageStats = {
    totalCostUsd:
      rec.costUsd !== null && !Number.isNaN(rec.costUsd)
        ? current.totalCostUsd + rec.costUsd
        : current.totalCostUsd,
    totalRequests: current.totalRequests + 1,
    unknownPriceRequests:
      rec.costUsd === null
        ? current.unknownPriceRequests + 1
        : current.unknownPriceRequests,
    totalInputTokens: current.totalInputTokens + Math.max(0, rec.inputTokens),
    totalOutputTokens: current.totalOutputTokens + Math.max(0, rec.outputTokens),
    totalCachedTokens: current.totalCachedTokens + Math.max(0, rec.cachedTokens),
    totalReasoningTokens:
      current.totalReasoningTokens + Math.max(0, rec.reasoningTokens),
    updatedAt: new Date().toISOString(),
  };
  saveGlobalUsage(next, customHomeDir);
  return next;
}

export function createSessionId(): string {
  return `ses-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function cleanSessionTitle(raw: string): string {
  const withoutTags = raw
    .replace(/\[clipboard-[^\]]*\]/gi, '')
    .replace(/\[[^\[\]\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp)\]/gi, '')
    .replace(/Ruta interna:\s*\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const base = withoutTags || 'Conversación';
  return base.length > 42 ? `${base.slice(0, 41)}…` : base;
}

export function countRealUserTurns(
  session: Pick<SavedSession, 'history' | 'messages'>,
): number {
  if (Array.isArray(session.messages) && session.messages.length > 0) {
    const userMsgs = session.messages.filter((m) => m.role === 'user');
    if (userMsgs.length > 0) {
      return userMsgs.length;
    }
  }
  if (!Array.isArray(session.history)) {
    return 0;
  }
  let count = 0;
  for (const turn of session.history) {
    if (turn.role !== 'user') continue;
    const parts = turn.parts ?? [];
    const hasFnResponse = parts.some((p) => Boolean(p.functionResponse));
    if (hasFnResponse) continue;
    const texts = parts
      .map((p) => (typeof p.text === 'string' ? p.text.trim() : ''))
      .filter(Boolean);
    if (texts.length === 0) continue;
    const joined = texts.join(' ');
    if (
      joined === 'continúa' ||
      joined.startsWith('[Contexto resumido automáticamente]') ||
      joined.startsWith('[Resultados de subagentes finalizados]')
    ) {
      continue;
    }
    count += 1;
  }
  return count;
}

export function formatRelativeSessionDate(
  updatedAt: string,
  now: Date = new Date(),
): string {
  const clean = updatedAt.trim();
  if (!clean) return 'reciente';
  const isoCandidate = clean.includes('T') ? clean : clean.replace(' ', 'T') + 'Z';
  const parsedMs = Date.parse(isoCandidate);
  if (Number.isNaN(parsedMs)) {
    return clean.slice(0, 10);
  }
  const diffSec = Math.max(0, Math.floor((now.getTime() - parsedMs) / 1000));
  if (diffSec < 60) return 'ahora';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `hace ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'ayer';
  if (diffDays < 30) return `hace ${diffDays}d`;
  return clean.slice(0, 10);
}

export function countCompletedConversationTurns(
  messages: readonly SavedUiMessage[],
): number {
  let completed = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== 'user') continue;
    let hasModelReply = false;
    let wasCancelled = false;
    for (let j = i + 1; j < messages.length; j++) {
      const msg = messages[j]!;
      if (msg.role === 'user') break;
      if (
        msg.toolStatus === 'cancelado' ||
        (msg.role === 'system' &&
          /cancelad[oa]\s+por\s+el\s+usuario/i.test(msg.text))
      ) {
        wasCancelled = true;
      }
      if (msg.role === 'model' && msg.text.trim().length > 0) {
        hasModelReply = true;
      }
    }
    if (hasModelReply && !wasCancelled) {
      completed += 1;
    }
  }
  return completed;
}

export function isBareGreetingMessage(raw: string): boolean {
  const clean = raw
    .replace(/\[clipboard-[^\]]*\]/gi, '')
    .replace(/\[[^\[\]\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp)\]/gi, '')
    .replace(/Ruta interna:\s*\S+/gi, '')
    .replace(/[¡!¿?.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!clean) return true;
  return /^(?:hola|buenas(?:\s+tardes|\s+noches|\s+dias|\s+días)?|hey+|oye|que\s+hubo|q\s+hubo|como\s+vas?|como\s+estas?|saludos|parcero|bro|amigo)(?:\s+(?:parcero|bro|amigo|como\s+va|como\s+vas|como\s+estas|que\s+tal|todo\s+bien))*$/i.test(
    clean,
  );
}

export function deriveSessionTitle(
  messages: readonly SavedUiMessage[],
  history: readonly Content[],
  customTitle?: string,
): string {
  if (customTitle && customTitle.trim().length > 0) {
    return cleanSessionTitle(customTitle);
  }
  const firstUserMsg = messages.find((m) => m.role === 'user')?.text;
  const raw =
    firstUserMsg ??
    history.find((h) => h.role === 'user')?.parts?.[0]?.text ??
    'Nueva conversación';
  return cleanSessionTitle(raw);
}

export function buildFallbackTopicTitle(rawFirstUserMsg: string): string {
  const withoutTags = rawFirstUserMsg
    .replace(/\[clipboard-[^\]]*\]/gi, '')
    .replace(/\[[^\[\]\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp)\]/gi, '')
    .replace(/Ruta interna:\s*\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutTags) return 'Nueva conversación';

  const crearMatch = withoutTags.match(
    /^(?:hola[,.\s!]*)?(?:buenas[,.\s!]*)?(?:oye[,.\s!]*)?(?:vamos a |quiero |necesito |ay[uú]dame a )?crear\s+(?:una?\s+)?(.+)$/i,
  );
  if (crearMatch?.[1]) {
    const rest = crearMatch[1]
      .trim()
      .replace(/[.!?]+$/, '')
      .replace(
        /\b(html|css|js|ts|api|cli|ui|tui|mcp|sql)\b/gi,
        (m) => m.toUpperCase(),
      );
    if (rest) {
      return cleanSessionTitle(`Creación de ${rest}`);
    }
  }
  return cleanSessionTitle(withoutTags);
}

export interface GenerateSessionSummaryTitleParams {
  messages: readonly SavedUiMessage[];
  history: readonly Content[];
  adapter: ProviderAdapter;
  summaryModel?: string;
  abortSignal?: AbortSignal;
}

export async function generateSessionSummaryTitle(
  params: GenerateSessionSummaryTitleParams,
): Promise<string | null> {
  const modelId = params.summaryModel?.trim() || 'gemini-3.1-pro-preview';
  const relevantMessages = params.messages
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'model') && m.text.trim().length > 0,
    )
    .slice(0, 10);

  if (relevantMessages.length === 0) {
    return null;
  }

  const transcript = relevantMessages
    .map((m) => {
      const roleLabel = m.role === 'user' ? 'Usuario' : 'Agente';
      const cleanText = m.text
        .replace(/\[clipboard-[^\]]*\]/gi, '')
        .replace(/Ruta interna:\s*\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      return `${roleLabel}: ${cleanText}`;
    })
    .join('\n');

  const promptText = [
    'Conversación hasta ahora:',
    transcript,
    '',
    'Genera un título corto y descriptivo en español (de 3 a 7 palabras, máximo 40 caracteres, sin comillas ni punto final) que resuma de qué trata el chat según el agente.',
    'Ejemplo: si el usuario dice "hola vamos a crear una app con html", responde "Creación de app con HTML".',
  ].join('\n');

  let rawOutput = '';
  try {
    for await (const chunk of params.adapter.streamTurn(
      [{ role: 'user', parts: [{ text: promptText }] }],
      {
        model: modelId,
        effort: 'low',
        includeThoughts: false,
        subMode: 'plan',
        enableTools: false,
        abortSignal: params.abortSignal,
        systemInstruction:
          'Eres un generador de títulos breves para el historial de conversaciones (/resume). Responde únicamente con el título resumido en español (máximo 40 caracteres), sin comillas, sin emojis y sin explicaciones adicionales.',
      },
    )) {
      if (chunk.text) {
        rawOutput += chunk.text;
      }
    }
    const cleaned = rawOutput
      .replace(/^["'«»`]+|["'«»`.]+$/g, '')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) {
      const firstUser =
        relevantMessages.find((m) => m.role === 'user')?.text ?? '';
      return firstUser ? buildFallbackTopicTitle(firstUser) : null;
    }
    return cleanSessionTitle(cleaned);
  } catch {
    const firstUser =
      relevantMessages.find((m) => m.role === 'user')?.text ?? '';
    return firstUser ? buildFallbackTopicTitle(firstUser) : null;
  }
}

export function saveSessionToDisk(
  session: SavedSession,
  customHomeDir?: string,
): void {
  if (
    session.history.length === 0 &&
    session.messages.every((m) => m.role === 'system')
  ) {
    return;
  }
  const dir = getSessionsDir(customHomeDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSaveSessionToDisk(
  session: SavedSession,
  customHomeDir?: string,
  delayMs = 250,
): void {
  if (
    session.history.length === 0 &&
    session.messages.every((m) => m.role === 'system')
  ) {
    return;
  }
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
  }
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    const dir = getSessionsDir(customHomeDir);
    void fs.promises
      .mkdir(dir, { recursive: true })
      .then(() => {
        const filePath = path.join(dir, `${session.id}.json`);
        return fs.promises.writeFile(filePath, JSON.stringify(session), {
          encoding: 'utf-8',
          mode: 0o600,
        });
      })
      .catch(() => {
        // Ignorar errores de guardado en background
      });
  }, delayMs);
}

export function listSavedSessions(customHomeDir?: string): SavedSession[] {
  const dir = getSessionsDir(customHomeDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const sessions: SavedSession[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const parsed = JSON.parse(raw) as SavedSession;
      if (parsed && parsed.id && Array.isArray(parsed.history)) {
        sessions.push({
          ...parsed,
          costRecords: Array.isArray(parsed.costRecords)
            ? parsed.costRecords
            : [],
          sessionCostUsd:
            typeof parsed.sessionCostUsd === 'number'
              ? parsed.sessionCostUsd
              : null,
          lastApiPromptTokens:
            typeof parsed.lastApiPromptTokens === 'number'
              ? parsed.lastApiPromptTokens
              : null,
        });
      }
    } catch {
      // Ignora archivos corruptos
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
