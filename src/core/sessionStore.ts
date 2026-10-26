import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Content } from '@google/genai';

export interface SavedUiMessage {
  id: string;
  role: 'user' | 'model' | 'system';
  text: string;
  thoughtText?: string;
  timestamp?: string;
  durationText?: string;
}

export interface SavedSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  effort: string;
  history: Content[];
  messages: SavedUiMessage[];
}

export function getSessionsDir(customHomeDir?: string): string {
  const home = customHomeDir ?? os.homedir();
  return path.join(home, '.glitch', 'sessions');
}

export function createSessionId(): string {
  return `ses-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function deriveSessionTitle(
  messages: readonly SavedUiMessage[],
  history: readonly Content[],
): string {
  const firstUserMsg = messages.find((m) => m.role === 'user')?.text;
  const raw =
    firstUserMsg ??
    history.find((h) => h.role === 'user')?.parts?.[0]?.text ??
    'Nueva conversación';
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  return singleLine.length > 48 ? `${singleLine.slice(0, 45)}...` : singleLine;
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
        sessions.push(parsed);
      }
    } catch {
      // Ignora archivos corruptos
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
