import { describe, expect, it } from 'vitest';
import {
  GLITCH_ASCII_LINES,
  formatStartupBanner,
} from '../ui/banner.js';

describe('Banner de inicio estilo Codex CLI', () => {
  it('mantiene todas las líneas del arte ASCII alineadas a 80 columnas exactas', () => {
    expect(GLITCH_ASCII_LINES.length).toBe(40);
    for (const line of GLITCH_ASCII_LINES) {
      expect(line.length).toBe(80);
    }
  });

  it('incluye el encabezado >_ Glitch CLI, versión y el arte centrado', () => {
    const banner = formatStartupBanner('0.1.0', 120);
    expect(banner).toContain('>_ Glitch CLI');
    expect(banner).toContain('(v0.1.0)');
    expect(banner).toContain('*#%%#+=');
  });
});
