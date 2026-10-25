import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatAuthSummary,
  getSettingsPath,
  isAuthConfigured,
  loadSettings,
  maskApiKey,
  saveSettings,
} from '../config/settings.js';
import { runAuthFlow } from '../commands/auth.js';
import { createVertexGenAI } from '../providers/vertex.js';

describe('Etapa 1: Configuración, enmascarado y /auth', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glitch-test-'));
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('guarda y carga settings en ~/.glitch/settings.json', () => {
    const initial = loadSettings(tempHome);
    expect(isAuthConfigured(initial)).toBe(false);

    saveSettings(
      {
        ...initial,
        provider: 'vertex',
        vertex: { project: 'mi-proyecto-gcp', location: 'us-central1' },
      },
      tempHome,
    );

    const settingsFile = getSettingsPath(tempHome);
    expect(fs.existsSync(settingsFile)).toBe(true);

    const reloaded = loadSettings(tempHome);
    expect(isAuthConfigured(reloaded)).toBe(true);
    expect(reloaded.provider).toBe('vertex');
    expect(reloaded.vertex).toEqual({
      project: 'mi-proyecto-gcp',
      location: 'us-central1',
    });
  });

  it('nunca muestra la API key completa en maskApiKey ni en formatAuthSummary', () => {
    const secretKey = 'sk-proj-1234567890abcdefSECRET9876';
    const masked = maskApiKey(secretKey);
    expect(masked).toBe('sk-****9876');
    expect(masked).not.toContain('1234567890abcdefSECRET');

    expect(maskApiKey('short')).toBe('****');
    expect(maskApiKey('')).toBe('(vacía)');

    const summary = formatAuthSummary({
      model: 'gemini-2.5-pro',
      effort: 'medium',
      thoughts: true,
      permissionMode: 'ask_insecure',
      subMode: 'agent',
      provider: 'custom',
      custom: {
        baseUrl: 'https://api.example.com',
        apiKey: secretKey,
        format: 'chat_completions',
      },
    });
    expect(summary).toContain('sk-****9876');
    expect(summary).not.toContain(secretKey);
  });

  it('ejecuta el flujo /auth para Vertex AI y guarda GOOGLE_CLOUD_PROJECT y GOOGLE_CLOUD_LOCATION', async () => {
    const answers = ['1', 'free-trial-project-123', 'us-east5'];
    let idx = 0;
    const logs: string[] = [];

    const initial = loadSettings(tempHome);
    const updated = await runAuthFlow(
      initial,
      async () => answers[idx++] ?? '',
      (msg) => logs.push(msg),
      tempHome,
    );

    expect(updated.provider).toBe('vertex');
    expect(updated.vertex).toEqual({
      project: 'free-trial-project-123',
      location: 'us-east5',
    });
    expect(process.env['GOOGLE_CLOUD_PROJECT']).toBe('free-trial-project-123');
    expect(process.env['GOOGLE_CLOUD_LOCATION']).toBe('us-east5');

    const ai = createVertexGenAI(updated.vertex!);
    expect(ai.vertexai).toBe(true);
  });

  it('ejecuta el flujo /auth para API personalizada y oculta la API key en la salida', async () => {
    const rawKey = 'sk-custom-super-secret-key-9999';
    const answers = ['2', 'https://my-llm.local', rawKey, '2'];
    let idx = 0;
    const logs: string[] = [];

    const initial = loadSettings(tempHome);
    const updated = await runAuthFlow(
      initial,
      async () => answers[idx++] ?? '',
      (msg) => logs.push(msg),
      tempHome,
    );

    expect(updated.provider).toBe('custom');
    expect(updated.custom).toEqual({
      baseUrl: 'https://my-llm.local',
      apiKey: rawKey,
      format: 'responses',
    });

    const fullLogOutput = logs.join(' | ');
    expect(fullLogOutput).not.toContain(rawKey);
    expect(fullLogOutput).toContain('sk-****9999');
  });
});
