import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../config/settings.js';
import {
  GLITCH_ASCII_LINES,
  GLITCH_MINI_LOGO_LINES,
  formatClaudeStyleHeaderInfo,
  formatStartupBanner,
} from '../ui/banner.js';
import { formatSessionCostSummary } from '../ui/statusBar.js';

describe('Banner y Cabecera estilo Claude Code / Glitch CLI', () => {
  it('mantiene todas las líneas del arte ASCII alineadas a 80 columnas exactas', () => {
    expect(GLITCH_ASCII_LINES.length).toBe(40);
    for (const line of GLITCH_ASCII_LINES) {
      expect(line.length).toBe(80);
    }
    expect(GLITCH_MINI_LOGO_LINES.length).toBe(3);
  });

  it('formatea la cabecera estilo Claude Code (nombre, versión, modelo + esfuerzo + proveedor, ruta) y el costo de sesión', () => {
    const banner = formatStartupBanner('0.1.0', 120);
    expect(banner).toContain('Glitch CLI');
    expect(banner).toContain('(v0.1.0)');
    expect(banner).toContain('*#%%#+=');

    const headerInfo = formatClaudeStyleHeaderInfo(
      {
        ...DEFAULT_SETTINGS,
        provider: 'vertex',
        model: 'gemini-4-argon',
        effort: 'high',
        language: 'es',
      },
      '0.1.0',
    );
    expect(headerInfo.line1Title).toBe('Glitch CLI');
    expect(headerInfo.line1Version).toBe('v0.1.0');
    expect(headerInfo.line2ModelAuth).toBe(
      'Gemini 4 Argon (1M context) con esfuerzo high · Vertex AI',
    );

    expect(formatSessionCostSummary(0.27, 0.16, '4s', 'es')).toBe(
      '$0.27 | último $0.16 · 4s',
    );
    expect(formatSessionCostSummary(0.27, 0.16, '4s', 'en')).toBe(
      '$0.27 | last $0.16 · 4s',
    );
  });
});
