import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import {
  APP_VERSION,
  DEFAULT_MODEL_PRICING,
  DEFAULT_SETTINGS,
  getAppVersion,
  loadSettings,
  saveSettings,
} from '../config/settings.js';
import { getModelContextWindow, getModelDefinition } from '../config/models.js';
import { SessionState } from '../core/session.js';
import {
  formatCompactToolCallLine,
  formatToolActionSummary,
} from '../core/tools.js';
import {
  getGlobalUsagePath,
  listSavedSessions,
  loadGlobalUsage,
  recordRequestInGlobalUsage,
  saveSessionToDisk,
} from '../core/sessionStore.js';
import {
  SLASH_COMMANDS,
  matchSlashCommands,
  printHelpMenu,
  resolveSlashCommandAlias,
} from '../commands/slashRegistry.js';
import {
  GLITCH_ASCII_LINES,
  GLITCH_MINI_LOGO_LINES,
  formatClaudeStyleHeaderInfo,
  formatShortCwd,
  formatStartupBanner,
  isWindowsSystemDirectory,
} from '../ui/banner.js';
import { HeaderBanner } from '../ui/HeaderBanner.js';
import { formatSubagentStateLabel } from '../ui/SubagentsView.js';
import {
  buildCostRequestRecord,
  calculateApiUsageCostUsd,
  computeChatCostSummary,
  computeContextUsageBreakdown,
  formatChatTotalAmount,
  formatContextShortBarLabel,
  formatCostAuditReport,
  formatInputTopLeftWithTotal,
  formatInputTopRightInfo,
  formatSessionCostSummary,
  formatTelemetryStatusBarLine,
  formatThinkingStatusLine,
  formatUsdAmount,
} from '../ui/statusBar.js';
import {
  DEFAULT_INPUT_PLACEHOLDER_ES,
  InputUndoManager,
  applyBracketedPasteToEditor,
  createLineEditorState,
  formatInputPlaceholder,
} from '../core/lineEditor.js';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  BracketedPasteParser,
  getLastCopiedClipboardText,
  isSafeHttpUrl,
  normalizePastedText,
  openExternalHttpUrl,
  writeTextToClipboard,
} from '../core/clipboard.js';
import {
  buildLineLinkMap,
  findLinkAtLineColumn,
  formatThoughtPreviewLines,
  measureTextWidth,
  parseInlineMarkdownTokens,
  pickCodeSpanColor,
  truncateTextWithEllipsis,
  wrapTextByWords,
} from '../ui/markdownRender.js';
import {
  DISABLE_MOUSE_REPORTING,
  ENABLE_MOUSE_REPORTING,
  TuiApp,
  computeEffectiveScrollTop,
  computeScrollbarThumb,
  decodeSgrMousePacket,
  formatScrollToBottomLabel,
  parseMouseEventsFromChunk,
  parseMouseWheelSequences,
  scrollChatStateBy,
  scrollTopFromScrollbarTrackRow,
  shouldShowHeaderForRows,
  shouldShowScrollToBottomButton,
} from '../ui/TuiApp.js';

describe('Banner y Cabecera estilo Claude Code / Glitch CLI', () => {
  it('mantiene todas las líneas del arte ASCII alineadas a 80 columnas exactas', () => {
    expect(GLITCH_ASCII_LINES.length).toBe(40);
    for (const line of GLITCH_ASCII_LINES) {
      expect(line.length).toBe(80);
    }
    expect(GLITCH_MINI_LOGO_LINES.length).toBe(3);
  });

  it('lee la versión real desde package.json (v0.2.0) sin hardcodear v0.1.0 y expone scripts de versionado y CHANGELOG.md', () => {
    const pkgRaw = fs.readFileSync(
      path.resolve(process.cwd(), 'package.json'),
      'utf-8',
    );
    const pkg = JSON.parse(pkgRaw) as {
      version: string;
      scripts: Record<string, string>;
    };

    expect(pkg.version).toBe('0.3.0');
    expect(getAppVersion()).toBe(pkg.version);
    expect(APP_VERSION).toBe('0.3.0');
    expect(pkg.scripts['version:patch']).toBeDefined();
    expect(pkg.scripts['version:minor']).toBeDefined();
    expect(pkg.scripts['version:major']).toBeDefined();

    const changelog = fs.readFileSync(
      path.resolve(process.cwd(), 'CHANGELOG.md'),
      'utf-8',
    );
    expect(changelog).toContain('v0.2.0');
    expect(changelog.toLowerCase()).toContain('autocompactación');
    expect(changelog.toLowerCase()).toContain('deshacer/rehacer');
    expect(changelog.toLowerCase()).toContain('cola de espera');
    expect(changelog.toLowerCase()).toContain('reintentos');
    expect(changelog.toLowerCase()).toContain('layout');
    expect(changelog.toLowerCase()).toContain('pegado');

    const banner = formatStartupBanner(undefined, 120);
    expect(banner).toContain('Glitch CLI');
    expect(banner).toContain(`(v${pkg.version})`);
    expect(banner).toContain('*#%%#+=');

    const headerInfo = formatClaudeStyleHeaderInfo({
      ...DEFAULT_SETTINGS,
      provider: 'vertex',
      model: 'gemini-4-argon',
      effort: 'high',
    });
    expect(headerInfo.line1Title).toBe('Glitch CLI');
    expect(headerInfo.line1Version).toBe(`v${pkg.version}`);
    expect(headerInfo.line2ModelAuth).toBe(
      'Gemini 4 Argon | Esfuerzo: Alto · Vertex AI',
    );

    const helpLines: string[] = [];
    printHelpMenu((line) => helpLines.push(line));
    const helpOutput = helpLines.join('\n');
    expect(helpOutput).toContain(`Glitch CLI v${pkg.version}`);
    expect(helpOutput).toContain('/version');
    expect(resolveSlashCommandAlias('/version')).toBe('/version');
    expect(resolveSlashCommandAlias('/ver')).toBe('/version');

    expect(formatSessionCostSummary(0.27, 0.16, '4s')).toBe(
      '$0.2700 | último $0.1600 · 4s',
    );
    expect(formatThinkingStatusLine('5m 8s', 0.0123)).toBe(
      'Pensando 5m 8s  esc para cancelar',
    );
    expect(formatUsdAmount(null)).toBe('sin precio');

    // Prueba obligatoria: respuesta simulada de 100.000 tokens de entrada, 2.000 de salida y 8.000 de razonamiento
    // Cálculo manual con tabla de precios de gemini-4-argon (input=$2.00/1M, output+reasoning=$10.00/1M, plano):
    // (100,000 * 2.00 + (2,000 + 8,000) * 10.00) / 1,000,000 = (200,000 + 100,000) / 1,000,000 = $0.3000
    const simulated100kUsage = {
      inputTokens: 100_000,
      cachedTokens: 0,
      outputTokens: 2_000,
      reasoningTokens: 8_000,
      totalPromptTokens: 100_000,
      rawMetadata: {
        promptTokenCount: 100_000,
        candidatesTokenCount: 2_000,
        thoughtsTokenCount: 8_000,
        cachedContentTokenCount: null,
        toolUsePromptTokenCount: null,
        totalTokenCount: 110_000,
      },
    };
    const manualExpectedCost =
      (100_000 * 2.0 + 0 * 0.1 + (2_000 + 8_000) * 10.0) / 1_000_000;
    const calc100kCost = calculateApiUsageCostUsd(
      simulated100kUsage,
      'gemini-4-argon',
      DEFAULT_SETTINGS.modelPricing,
      true,
      { referenceDate: '2026-10-25' },
    );
    expect(calc100kCost).toBeCloseTo(manualExpectedCost, 8);
    expect(formatUsdAmount(calc100kCost)).toBe('$0.3000');

    // Verifica tramo >200k tokens en Gemini 3.1 Pro (input=$4.00/1M, output=$18.00/1M) y Gemini 4 Argon plano ($2.00/$10.00)
    const over200kUsage = {
      inputTokens: 250_000,
      cachedTokens: 0,
      outputTokens: 2_000,
      reasoningTokens: 8_000,
      totalPromptTokens: 250_000,
    };
    const over200kCostArgon = calculateApiUsageCostUsd(
      over200kUsage,
      'gemini-4-argon',
      DEFAULT_SETTINGS.modelPricing,
      true,
      { referenceDate: '2026-10-25' },
    );
    expect(over200kCostArgon).toBeCloseTo(
      (250_000 * 2.0 + 10_000 * 10.0) / 1_000_000,
      8,
    );

    const over200kCost31Pro = calculateApiUsageCostUsd(
      over200kUsage,
      'gemini-3.1-pro-preview',
      DEFAULT_SETTINGS.modelPricing,
      true,
    );
    expect(over200kCost31Pro).toBeCloseTo(
      (250_000 * 4.0 + 10_000 * 18.0) / 1_000_000,
      8,
    );

    // Verifica registro detallado (/debug cost y /usage) con campos "no reportado" y aviso de precio de lista
    const rec1 = buildCostRequestRecord({
      requestIndex: 1,
      turnIndex: 1,
      kind: 'agent',
      model: 'gemini-4-argon',
      usage: simulated100kUsage,
      pricingTable: DEFAULT_SETTINGS.modelPricing,
      referenceDate: '2026-10-25',
    });
    const auditReport = formatCostAuditReport(
      [rec1],
      rec1.costUsd,
      rec1.costUsd,
      'gemini-4-argon',
      DEFAULT_SETTINGS.modelPricing,
    ).join('\n');
    expect(auditReport).toContain('entrada=100,000');
    expect(auditReport).toContain('caché=no reportado');
    expect(auditReport).toContain('toolPrompt=no reportado');
    expect(auditReport).toContain('salida=2,000');
    expect(auditReport).toContain('razonamiento=8,000');
    expect(auditReport).toContain('costo=$0.3000');
    expect(auditReport).toContain('precio de lista oficial de Vertex AI');

    const sampleApiUsage = {
      inputTokens: 100_000,
      cachedTokens: 80_000,
      outputTokens: 50_000,
      reasoningTokens: 25_000,
    };
    const calculatedCost = calculateApiUsageCostUsd(
      sampleApiUsage,
      'gemini-4-argon',
      DEFAULT_SETTINGS.modelPricing,
      true,
      { referenceDate: '2026-10-25' },
    );
    expect(calculatedCost).toBeCloseTo(0.958, 6);
    expect(formatUsdAmount(calculatedCost)).toBe('$0.9580');

    const unknownModelCost = calculateApiUsageCostUsd(
      sampleApiUsage,
      'modelo-inexistente-xyz',
      DEFAULT_SETTINGS.modelPricing,
      true,
    );
    expect(unknownModelCost).toBeNull();
    expect(formatThinkingStatusLine('1m 3s', unknownModelCost)).toBe(
      'Pensando 1m 3s  esc para cancelar',
    );

    // Modelo con precio 0 también devuelve null ("costo desconocido", nunca $0)
    const zeroPriceCost = calculateApiUsageCostUsd(
      sampleApiUsage,
      'gemini-4-argon',
      {
        'gemini-4-argon': {
          inputPerMillion: 0,
          outputPerMillion: 0,
          cachePerMillion: 0,
        },
      },
      true,
    );
    expect(zeroPriceCost).toBeNull();

    expect(DEFAULT_INPUT_PLACEHOLDER_ES).toBe('Escribe o / para comandos');
    expect(formatInputPlaceholder(DEFAULT_INPUT_PLACEHOLDER_ES, 120, 14)).toBe(
      'Escribe o / para comandos',
    );
    const narrowPlaceholder = formatInputPlaceholder(
      DEFAULT_INPUT_PLACEHOLDER_ES,
      32,
      14,
    );
    expect(narrowPlaceholder.endsWith('...')).toBe(true);
    expect(narrowPlaceholder.length).toBeLessThanOrEqual(32 - 14 - 6);
  });

  it('mantiene un solo estilo visual (glitch), comandos en español y calcula el desglose real de contexto (/usage)', () => {
    expect(SLASH_COMMANDS.some((c) => c.cmd === '/tui')).toBe(true);
    expect(SLASH_COMMANDS.every((c) => typeof c.displayCmd === 'string')).toBe(
      true,
    );
    expect(SLASH_COMMANDS.every((c) => typeof c.desc === 'string')).toBe(true);
    expect(resolveSlashCommandAlias('/contexto')).toBe('/usage');
    expect(SLASH_COMMANDS.some((c) => c.cmd === '/debug')).toBe(false);
    expect(matchSlashCommands('/').some((c) => c.cmd.includes(' '))).toBe(
      false,
    );
    expect(matchSlashCommands('/skills').map((c) => c.cmd)).toEqual([
      '/skills',
    ]);

    const breakdown = computeContextUsageBreakdown(
      [{ role: 'user', parts: [{ text: 'Hola mundo' }] }],
      'agent',
      [
        {
          name: 'test-skill',
          description: 'Skill de prueba',
          sourceLabel: '~/.agents/skills',
          filePath: '/tmp/SKILL.md',
          approxTokens: 120,
          content: 'Contenido de skill activa'.repeat(20),
        },
      ],
      ['Contenido de skill activa'.repeat(20)],
    );

    expect(breakdown.baseSystemTokens).toBeGreaterThan(50);
    expect(breakdown.toolSchemaTokens).toBeGreaterThan(100);
    expect(breakdown.mcpTokens).toBeGreaterThanOrEqual(0);
    expect(breakdown.skillsCatalogTokens).toBeGreaterThan(5);
    expect(breakdown.activeSkillsTokens).toBeGreaterThan(100);
    expect(breakdown.totalUsedTokens).toBe(
      breakdown.baseSystemTokens +
        breakdown.toolSchemaTokens +
        breakdown.mcpTokens +
        breakdown.skillsCatalogTokens +
        breakdown.activeSkillsTokens +
        breakdown.historyTextTokens +
        breakdown.historyThoughtTokens +
        breakdown.historyToolCallTokens,
    );

    // Verifica el formato exacto de Paso 5 en la barra de estado: "context: 10.8k / 1M . 5 MCP . 3 SKILLS . $1.61"
    expect(formatContextShortBarLabel(10_800, 1_048_576)).toBe(
      'context: 10.8k / 1M',
    );
    expect(
      formatTelemetryStatusBarLine({
        usedTokens: 10_800,
        maxTokens: 1_048_576,
        activeMcpCount: 5,
        activeSkillCount: 3,
        costUsd: 1.61,
      }),
    ).toBe('context: 10.8k / 1M . 5 MCP . 3 SKILLS . $1.61');

    // Singular/plural correcto (1 SKILL, 3 SKILLS, 1 MCP) y omisión de segmentos con cero
    expect(
      formatTelemetryStatusBarLine({
        usedTokens: 10_800,
        maxTokens: 131_072, // Gemma 3 cambia el límite
        activeMcpCount: 1,
        activeSkillCount: 1,
        costUsd: 0,
      }),
    ).toBe('context: 10.8k / 131k . 1 MCP . 1 SKILL');

    expect(
      formatTelemetryStatusBarLine({
        usedTokens: 6_300,
        maxTokens: 1_048_576,
        activeMcpCount: 0,
        activeSkillCount: 0,
        costUsd: 0,
      }),
    ).toBe('context: 6.3k / 1M');

    // Anotación discreta de peticiones sin precio al lado del costo
    expect(
      formatTelemetryStatusBarLine({
        usedTokens: 10_800,
        maxTokens: 1_048_576,
        activeMcpCount: 0,
        activeSkillCount: 2,
        costUsd: 1.61,
        unknownPriceCount: 1,
      }),
    ).toBe('context: 10.8k / 1M . 2 SKILLS . $1.61 (+1 sin precio)');

    const topRight = formatInputTopRightInfo(
      [],
      5,
      3,
      breakdown.totalUsedTokens,
      10_800,
      1_048_576,
      1.61,
    );
    expect(topRight).toBe('context: 10.8k / 1M . 5 MCP . 3 SKILLS . $1.61');

    const tokens = parseInlineMarkdownTokens(
      '**Carpetas:** `C:\\Users\\Desktop` y `/usage` con *nota* y [green: OK]',
    );
    expect(tokens).toEqual([
      { kind: 'bold', content: 'Carpetas:' },
      { kind: 'text', content: ' ' },
      { kind: 'code', content: 'C:\\Users\\Desktop' },
      { kind: 'text', content: ' y ' },
      { kind: 'code', content: '/usage' },
      { kind: 'text', content: ' con ' },
      { kind: 'italic', content: 'nota' },
      { kind: 'text', content: ' y ' },
      { kind: 'color', color: 'green', content: 'OK' },
    ]);
    expect(pickCodeSpanColor('C:\\Users\\Desktop')).toBe('cyan');
    expect(pickCodeSpanColor('/usage')).toBe('magentaBright');
    expect(pickCodeSpanColor('computeContextUsageBreakdown')).toBe(
      'magentaBright',
    );

    // Verifica estados en minúscula sin corchetes y aviso de carpeta del sistema Windows (Errata #1 y Paso 2)
    expect(formatSubagentStateLabel('running')).toBe('en vivo');
    expect(formatSubagentStateLabel('completed')).toBe('listo');
    expect(formatSubagentStateLabel('limit')).toBe('limite');
    expect(formatSubagentStateLabel('failed')).toBe('error');
    expect(formatSubagentStateLabel('cancelled')).toBe('cancelado');

    expect(isWindowsSystemDirectory('C:\\Windows\\System32')).toBe(true);
    expect(isWindowsSystemDirectory('C:\\Windows')).toBe(true);
    expect(isWindowsSystemDirectory('C:\\proyectos\\mi-app')).toBe(false);
    expect(formatShortCwd(process.cwd())).toBeTruthy();

    const sysHeaderRendered = renderToString(
      React.createElement(HeaderBanner, {
        settings: DEFAULT_SETTINGS,
        version: '0.2.0',
        cwd: 'C:\\Windows\\System32',
      }),
    );
    expect(sysHeaderRendered).toContain('estas en C:\\Windows\\System32');
  });

  it('mantiene el layout vertical fijo con encabezado arriba, espacio central flexible y barra inferior pegada al fondo (y oculta encabezado si rows < 12)', () => {
    expect(shouldShowHeaderForRows(24)).toBe(true);
    expect(shouldShowHeaderForRows(12)).toBe(true);
    expect(shouldShowHeaderForRows(11)).toBe(false);
    expect(shouldShowHeaderForRows(8)).toBe(false);

    const prevRows = process.stdout.rows;
    const prevCols = process.stdout.columns;
    try {
      process.stdout.columns = 100;
      process.stdout.rows = 24;

      const rendered24 = renderToString(
        React.createElement(TuiApp, {
          initialSettings: {
            ...DEFAULT_SETTINGS,
            provider: 'vertex',
            vertex: { project: 'demo-proj', location: 'us-central1' },
          },
        }),
      );
      const lines24 = rendered24.split('\n');
      expect(lines24.length).toBe(24);
      // Encabezado arriba (primeras líneas)
      expect(lines24.slice(0, 5).join('\n')).toContain('Glitch CLI');
      expect(lines24.slice(0, 5).join('\n')).toContain('v0.3.0');
      // Zona inferior pegada al borde inferior (últimas líneas) incluso con el chat vacío
      expect(lines24.slice(-6).join('\n')).toContain('Always Allow · Sub-Modo');
      expect(lines24.slice(-6).join('\n')).toContain('Salir: Ctrl+C');

      // Si el alto de la terminal es menor a 12 líneas, se oculta el encabezado
      process.stdout.rows = 10;
      const rendered10 = renderToString(
        React.createElement(TuiApp, {
          initialSettings: {
            ...DEFAULT_SETTINGS,
            provider: 'vertex',
            vertex: { project: 'demo-proj', location: 'us-central1' },
          },
        }),
      );
      const lines10 = rendered10.split('\n');
      expect(lines10.length).toBe(10);
      expect(rendered10).not.toContain('[Fusion: Claude + Codex + Gemini]');
      expect(lines10.slice(-5).join('\n')).toContain('Salir: Ctrl+C');
    } finally {
      process.stdout.rows = prevRows;
      process.stdout.columns = prevCols;
    }
  });

  it('gestiona scroll independiente en el historial (rueda del mouse, Re Pág, Av Pág) y sticky auto-scroll solo cuando el usuario estaba al final', () => {
    // Al inicio el usuario está al final (isAtBottom = true)
    let state = { scrollTop: 0, isAtBottom: true };
    expect(computeEffectiveScrollTop(state, 50)).toBe(50);

    // Si sube leyendo el historial, isAtBottom pasa a false
    state = scrollChatStateBy(state, -15, 50);
    expect(state.scrollTop).toBe(35);
    expect(state.isAtBottom).toBe(false);

    // Si llega un mensaje nuevo (maxScrollTop sube de 50 a 70) mientras lee arriba, NO lo mueve
    expect(computeEffectiveScrollTop(state, 70)).toBe(35);

    // Si baja hasta el final, vuelve a activar isAtBottom = true
    state = scrollChatStateBy(state, 100, 70);
    expect(state.scrollTop).toBe(70);
    expect(state.isAtBottom).toBe(true);
    expect(computeEffectiveScrollTop(state, 85)).toBe(85);

    // Rueda del mouse SGR (\x1b[<64;x;yM = arriba, \x1b[<65;x;yM = abajo)
    expect(parseMouseWheelSequences('\x1b[<64;40;12M')).toEqual({
      wheelDeltaLines: -3,
      rightClickPaste: false,
    });
    expect(parseMouseWheelSequences('\x1b[<65;40;12M\x1b[<65;40;12M')).toEqual({
      wheelDeltaLines: 6,
      rightClickPaste: false,
    });
    expect(parseMouseWheelSequences('\x1b[<2;40;12M')).toEqual({
      wheelDeltaLines: 0,
      rightClickPaste: true,
    });
  });

  it('conserva saltos de línea al pegar múltiples líneas con Bracketed Paste Mode (\x1b[200~..\x1b[201~) en un solo paso de deshacer/rehacer', () => {
    const parser = new BracketedPasteParser();
    const chunk1 = `${BRACKETED_PASTE_START} primera línea\r\nsegunda línea`;
    const chunk2 = `\rtercera línea${BRACKETED_PASTE_END}`;

    expect(parser.push(chunk1)).toEqual([]);
    expect(parser.isPasting()).toBe(true);

    const segments = parser.push(chunk2);
    expect(parser.isPasting()).toBe(false);
    expect(segments).toEqual([
      {
        kind: 'paste',
        text: ' primera línea\nsegunda línea\ntercera línea',
      },
    ]);

    const undoManager = new InputUndoManager();
    let editorState = createLineEditorState('prefijo: ');
    editorState = applyBracketedPasteToEditor(
      editorState,
      `${BRACKETED_PASTE_START}linea 1\r\nlinea 2\nlinea 3${BRACKETED_PASTE_END}`,
      undoManager,
      1000,
    );

    expect(editorState.text).toBe('prefijo: linea 1\nlinea 2\nlinea 3');
    expect(normalizePastedText('a\r\nb\rc')).toBe('a\nb\nc');
    // Todo el pegado multilínea cuenta como 1 solo paso en deshacer/rehacer
    expect(undoManager.getUndoCount()).toBe(1);

    const undone = undoManager.undo(editorState);
    expect(undone?.text).toBe('prefijo: ');

    const redone = undoManager.redo(undone!);
    expect(redone?.text).toBe('prefijo: linea 1\nlinea 2\nlinea 3');
  });

  it('envuelve una cadena larga con acentos y emojis en 40, 80 y 120 columnas con string-width sin superar el ancho ni partir palabras', () => {
    const longText =
      '¡Hola! 🚀 Esta es una validación técnica de envoltura automática con acentos (canción, pingüino, árbol, éxito, niño) y emojis ⚡🧩🤖✅ para comprobar que ninguna palabra se parte a la mitad como un texto roto al cambiar entre distintos tamaños de ventana.';
    const expectedWords = longText.trim().split(/\s+/);

    for (const width of [40, 80, 120]) {
      const lines = wrapTextByWords(longText, width);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        // Ninguna línea supera el ancho visual calculado con string-width
        expect(measureTextWidth(line)).toBeLessThanOrEqual(width);
        // Ninguna línea inicia ni termina con espacios de más
        expect(line.startsWith(' ')).toBe(false);
        expect(line.endsWith(' ')).toBe(false);
      }

      // Al volver a unir las líneas con un espacio, todas las palabras siguen íntegras sin partirse
      const rejoinedWords = lines.join(' ').split(/\s+/);
      expect(rejoinedWords).toEqual(expectedWords);
    }

    // Verifica recorte con "..." en comandos largos de herramientas y límite de 5 líneas en razonamiento
    const longCmd =
      '⚡ Ejecutando run_shell_command (Get-ChildItem -Path C:\\Users\\WinterOS\\Documents\\ProyectoMuyLargo -Recurse -Force)...';
    const truncatedCmd = truncateTextWithEllipsis(longCmd, 50);
    expect(measureTextWidth(truncatedCmd)).toBeLessThanOrEqual(50);
    expect(truncatedCmd.endsWith('...')).toBe(true);

    const longReasoning = Array.from(
      { length: 10 },
      (_, i) => `Step ${i + 1}: Analyzing module dependencies and layout constraints in detail.`,
    ).join('\n');
    const preview = formatThoughtPreviewLines(longReasoning, 60, 5);
    expect(preview.length).toBe(5);
    expect(preview[4]!.endsWith('...')).toBe(true);
    for (const ln of preview) {
      expect(measureTextWidth(ln)).toBeLessThanOrEqual(60);
    }
  });

  it('muestra el total gastado del chat en "Always Allow · Sub-Modo: Agente · Total: $0.0290", lo acorta u oculta en terminales angostas y coincide con el desglose por turno de /usage', () => {
    const rightBar =
      'Contexto: 6.3k usados de 1M (99% libre) · 5 MCP activos · 67 skills';

    // 1. Formato estándar con 4 decimales (tanto < $1 como > $1) y "Total: sin precio" si no hay precio
    expect(
      formatInputTopLeftWithTotal(DEFAULT_SETTINGS, 0.0365, rightBar, 140),
    ).toBe('Always Allow · Sub-Modo: Agente · Total: $0.0365');
    expect(
      formatInputTopLeftWithTotal(DEFAULT_SETTINGS, 1.2345, rightBar, 140),
    ).toBe('Always Allow · Sub-Modo: Agente · Total: $1.2345');
    expect(
      formatInputTopLeftWithTotal(DEFAULT_SETTINGS, null, rightBar, 140),
    ).toBe('Always Allow · Sub-Modo: Agente · Total: sin precio');

    // 2. En terminal angosta se acorta primero a "Tot: $0.0365" y, si aún no cabe, oculta el total antes que partir la línea
    expect(
      formatInputTopLeftWithTotal(DEFAULT_SETTINGS, 0.0365, '', 46 + 6),
    ).toBe('Always Allow · Sub-Modo: Agente · Tot: $0.0365');
    expect(
      formatInputTopLeftWithTotal(DEFAULT_SETTINGS, 0.0365, '', 35),
    ).toBe('Always Allow · Sub-Modo: Agente');

    // 3. Al abrir o limpiar el chat (/clear / /new), el total empieza en $0.0000
    const emptySummary = computeChatCostSummary(
      [],
      'gemini-4-argon',
      DEFAULT_SETTINGS.modelPricing,
    );
    expect(emptySummary.totalChatCostUsd).toBe(0);
    expect(formatChatTotalAmount(emptySummary.totalChatCostUsd)).toBe('$0.0000');

    // 4. Acumula turnos, llamadas a herramientas, sub-agentes y chunks en vivo (incluso al cambiar de modelo), y coincide con /usage
    const turn1Req1 = buildCostRequestRecord({
      requestIndex: 1,
      turnIndex: 1,
      kind: 'agent',
      model: 'gemini-4-argon',
      usage: {
        inputTokens: 10_000,
        cachedTokens: 0,
        outputTokens: 500,
        reasoningTokens: 1_150,
      }, // (10k * 2.0 + 1650 * 10) / 1M = 0.0200 + 0.0165 = $0.0365
      pricingTable: DEFAULT_SETTINGS.modelPricing,
      referenceDate: '2026-10-25',
    });
    const turn2Req1 = buildCostRequestRecord({
      requestIndex: 2,
      turnIndex: 2,
      kind: 'agent',
      model: 'gemini-2.5-flash', // cambio de modelo dentro del mismo chat
      usage: {
        inputTokens: 20_000,
        cachedTokens: 0,
        outputTokens: 2_000,
        reasoningTokens: 0,
      }, // (20k * 0.30 + 2k * 2.50) / 1M = 0.0060 + 0.0050 = $0.0110
      pricingTable: DEFAULT_SETTINGS.modelPricing,
    });

    // Mientras llega un chunk en vivo en el turno 2 (1,000 tokens de salida en flash = $0.0025), el total ya lo suma en vivo ($0.0365 + $0.0110 + $0.0025 = $0.0500)
    const liveSummary = computeChatCostSummary(
      [turn1Req1, turn2Req1],
      'gemini-2.5-flash',
      DEFAULT_SETTINGS.modelPricing,
      {
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 1_000,
        reasoningTokens: 0,
      },
      'gemini-2.5-flash',
    );
    expect(liveSummary.totalChatCostUsd).toBeCloseTo(0.05, 6);
    expect(formatChatTotalAmount(liveSummary.totalChatCostUsd)).toBe('$0.0500');

    // Al terminar el turno 2, /usage muestra el desglose por turno (Turno #1 y Turno #2) y el mismo total ($0.0475)
    const committedSummary = computeChatCostSummary(
      [turn1Req1, turn2Req1],
      'gemini-2.5-flash',
      DEFAULT_SETTINGS.modelPricing,
    );
    expect(committedSummary.totalChatCostUsd).toBeCloseTo(0.0475, 6);
    expect(committedSummary.turnBreakdowns).toHaveLength(2);
    expect(committedSummary.turnBreakdowns[0]?.costUsd).toBeCloseTo(0.0365, 6);
    expect(committedSummary.turnBreakdowns[1]?.costUsd).toBeCloseTo(0.011, 6);

    const usageReport = formatCostAuditReport(
      [turn1Req1, turn2Req1],
      committedSummary.lastTurnCostUsd,
      committedSummary.totalChatCostUsd,
      'gemini-2.5-flash',
      DEFAULT_SETTINGS.modelPricing,
    ).join('\n');
    expect(usageReport).toContain('Desglose por turno:');
    expect(usageReport).toContain('Turno #1 (1 pet.)');
    expect(usageReport).toContain('subtotal=$0.0365');
    expect(usageReport).toContain('Turno #2 (1 pet.)');
    expect(usageReport).toContain('subtotal=$0.0110');
    expect(usageReport).toContain('Total: $0.0475');
  });

  it('Paso 4: verifica migración de precios, cambio de tramo por fecha, petición sin precio conservando acumulado, ventana de contexto y persistencia en sesión y usage.json (tolerante a corrupto)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glitch-paso4-'));
    try {
      // 1. Cambio de tramo por fecha en gemini-4-argon (antes y después del 2026-12-01) y recargo regional (10%)
      const usage1M = {
        inputTokens: 1_000_000,
        cachedTokens: 1_000_000,
        outputTokens: 500_000,
        reasoningTokens: 500_000,
      };
      const beforeDec = calculateApiUsageCostUsd(
        usage1M,
        'gemini-4-argon',
        DEFAULT_MODEL_PRICING,
        true,
        { referenceDate: '2026-11-30' },
      );
      // 1M * $2 + 1M * $0.10 + 1M * $10 = $12.10
      expect(beforeDec).toBeCloseTo(12.1, 6);

      const afterDec = calculateApiUsageCostUsd(
        usage1M,
        'gemini-4-argon',
        DEFAULT_MODEL_PRICING,
        true,
        { referenceDate: '2026-12-01' },
      );
      // 1M * $4 + 1M * $0.20 + 1M * $20 = $24.20
      expect(afterDec).toBeCloseTo(24.2, 6);

      const withRegional10 = calculateApiUsageCostUsd(
        usage1M,
        'gemini-4-argon',
        DEFAULT_MODEL_PRICING,
        true,
        { referenceDate: '2026-11-30', regionalSurchargePct: 10 },
      );
      expect(withRegional10).toBeCloseTo(12.1 * 1.1, 6);

      // 2. Migración de precios: si pricingEditedModels está vacío reemplaza toda la tabla vieja; si editó un modelo, conserva solo ese
      saveSettings(
        {
          ...DEFAULT_SETTINGS,
          modelPricing: {
            'gemini-4-argon': {
              inputPerMillion: 1.25,
              outputPerMillion: 10,
              cachePerMillion: 0.3125,
            },
            'gemini-2.5-flash': {
              inputPerMillion: 0.99,
              outputPerMillion: 9.99,
              cachePerMillion: 0.09,
            },
          },
          pricingEditedModels: ['gemini-2.5-flash'],
        },
        tmpHome,
      );
      const migrated = loadSettings(tmpHome);
      expect(migrated.modelPricing?.['gemini-4-argon']?.inputPerMillion).toBe(
        2.0,
      );
      expect(migrated.modelPricing?.['gemini-2.5-flash']?.inputPerMillion).toBe(
        0.99,
      );

      // 3. Petición sin precio mantiene el total conocido y cuenta aparte cuántas no tienen precio
      const known1 = buildCostRequestRecord({
        requestIndex: 1,
        turnIndex: 1,
        kind: 'agent',
        model: 'gemini-4-argon',
        usage: {
          inputTokens: 100_000,
          cachedTokens: 0,
          outputTokens: 10_000,
          reasoningTokens: 0,
        }, // 0.20 + 0.10 = $0.30
        pricingTable: DEFAULT_MODEL_PRICING,
        referenceDate: '2026-10-25',
      });
      const unknown2 = buildCostRequestRecord({
        requestIndex: 2,
        turnIndex: 1,
        kind: 'tool_followup',
        model: 'modelo-sin-precio',
        usage: {
          inputTokens: 50_000,
          cachedTokens: 0,
          outputTokens: 5_000,
          reasoningTokens: 0,
        },
        pricingTable: DEFAULT_MODEL_PRICING,
      });
      const known3 = buildCostRequestRecord({
        requestIndex: 3,
        turnIndex: 2,
        kind: 'agent',
        model: 'gemini-4-argon',
        usage: {
          inputTokens: 50_000,
          cachedTokens: 0,
          outputTokens: 10_000,
          reasoningTokens: 0,
        }, // 0.10 + 0.10 = $0.20
        pricingTable: DEFAULT_MODEL_PRICING,
        referenceDate: '2026-10-25',
      });
      const mixedSummary = computeChatCostSummary(
        [known1, unknown2, known3],
        'gemini-4-argon',
        DEFAULT_MODEL_PRICING,
      );
      expect(mixedSummary.totalChatCostUsd).toBeCloseTo(0.5, 6);
      expect(mixedSummary.unknownPriceRequestCount).toBe(1);

      // 4. Ventana de contexto por modelo (Gemini 1.048.576, Gemma 3 131.072 "sin verificar", custom "sin verificar", imagen null)
      expect(getModelContextWindow('gemini-4-argon', 'vertex')).toBe(1_048_576);
      const gemmaDef = getModelDefinition('gemma-3-27b-it', 'vertex');
      expect(gemmaDef.contextWindow).toBe(131_072);
      expect(gemmaDef.contextWindowStatus).toBe('sin verificar');
      const imgDef = getModelDefinition('imagen-3.0-generate-002', 'vertex');
      expect(imgDef.contextWindow).toBeNull();
      const customDef = getModelDefinition('my-custom-llm', 'custom', undefined, {
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        format: 'chat_completions',
        contextWindow: 262_144,
      });
      expect(customDef.contextWindow).toBe(262_144);
      expect(customDef.contextWindowStatus).toBe('sin verificar');

      // 5. Guardar, cerrar, reabrir sesión y comparar + usage.json tolerante a archivo ausente o corrupto
      expect(loadGlobalUsage(tmpHome).totalCostUsd).toBe(0);
      fs.mkdirSync(path.dirname(getGlobalUsagePath(tmpHome)), {
        recursive: true,
      });
      fs.writeFileSync(getGlobalUsagePath(tmpHome), '{corrupt-json!!!', 'utf-8');
      expect(loadGlobalUsage(tmpHome).totalCostUsd).toBe(0);

      recordRequestInGlobalUsage(known1, tmpHome);
      recordRequestInGlobalUsage(unknown2, tmpHome);
      const globalAfter = loadGlobalUsage(tmpHome);
      expect(globalAfter.totalCostUsd).toBeCloseTo(0.3, 6);
      expect(globalAfter.totalRequests).toBe(2);
      expect(globalAfter.unknownPriceRequests).toBe(1);

      saveSessionToDisk(
        {
          id: 'ses-persist-1',
          title: 'Prueba persistencia costo',
          createdAt: '2026-10-25 10:00:00',
          updatedAt: '2026-10-25 10:05:00',
          model: 'gemini-4-argon',
          effort: 'medium',
          history: [{ role: 'user', parts: [{ text: 'Hola' }] }],
          messages: [],
          sessionCostUsd: 0.5,
          costRecords: [known1, unknown2, known3],
          lastApiPromptTokens: 60_000,
        },
        tmpHome,
      );

      const reopened = listSavedSessions(tmpHome)[0]!;
      const restoredSession = new SessionState(DEFAULT_SETTINGS);
      restoredSession.restoreFromSavedSession(reopened);
      expect(restoredSession.sessionCostUsd).toBeCloseTo(0.5, 6);
      expect(restoredSession.costRecords).toHaveLength(3);
      expect(restoredSession.unknownPriceRequestCount).toBe(1);
      expect(restoredSession.lastApiPromptTokenCount).toBe(60_000);

      // /new reinicia el costo de sesión pero no el acumulado global
      restoredSession.resetForNewSession();
      expect(restoredSession.sessionCostUsd).toBeNull();
      expect(restoredSession.costRecords).toHaveLength(0);
      expect(loadGlobalUsage(tmpHome).totalCostUsd).toBeCloseTo(0.3, 6);

      // Paso 7: formatToolActionSummary prioriza command sobre dir_path en run_shell_command, y solo muestra dir_path si difiere del cwd
      const sameCwdSummary = formatToolActionSummary(
        'run_shell_command',
        {
          command: 'npm test',
          dir_path: process.cwd(),
        },
        process.cwd(),
      );
      expect(sameCwdSummary).toBe('run_shell_command  npm test');
      expect(sameCwdSummary).not.toContain(process.cwd());

      const diffCwdSummary = formatToolActionSummary(
        'run_shell_command',
        {
          command: 'npm test',
          dir_path: 'C:\\otro\\proyecto',
        },
        'C:\\mi\\proyecto',
      );
      expect(diffCwdSummary).toBe(
        'run_shell_command  npm test (C:\\otro\\proyecto)',
      );

      const compactGrep = formatCompactToolCallLine({
        name: 'grep_search',
        args: { pattern: '402', dir_path: 'src/' },
        durationMs: 400,
        status: 'listo',
        baseCwd: 'C:\\mi\\proyecto',
      });
      expect(compactGrep).toBe('grep_search  "402"  src/  0.4s  listo');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('Paso 9: decodificación SGR con Ctrl y clic derecho, mapa de links http/https, tramo de barra de scroll, botón "ir al final" y modo selección (Ctrl+S)', () => {
    // 1. Modo selección (Errata #3): apaga solo 1000, 1006 y 1007 sin tocar 1049 ni 2004
    expect(DISABLE_MOUSE_REPORTING).toBe('\x1b[?1007l\x1b[?1006l\x1b[?1000l');
    expect(DISABLE_MOUSE_REPORTING).not.toContain('1049');
    expect(DISABLE_MOUSE_REPORTING).not.toContain('2004');
    expect(ENABLE_MOUSE_REPORTING).toBe('\x1b[?1000h\x1b[?1006h\x1b[?1007h');

    // 2. Decodificación de clics SGR con Ctrl (bit 16): Ctrl+clic izquierdo (Cb=16) y Ctrl+clic derecho (Cb=18, botón 2)
    const ctrlLeftPress = decodeSgrMousePacket(16, 25, 8, 'M');
    expect(ctrlLeftPress).toMatchObject({
      button: 0,
      ctrl: true,
      action: 'press',
      x: 25,
      y: 8,
    });
    const ctrlRightPress = decodeSgrMousePacket(16 | 2, 30, 8, 'M');
    expect(ctrlRightPress).toMatchObject({
      button: 2,
      ctrl: true,
      action: 'press',
      x: 30,
      y: 8,
    });
    const releaseEv = decodeSgrMousePacket(0, 10, 5, 'm');
    expect(releaseEv.action).toBe('release');

    // Ctrl+clic derecho NO dispara pegado normal (rightClickPaste = false)
    const parsedCtrlRight = parseMouseEventsFromChunk('\x1b[<18;30;8M');
    expect(parsedCtrlRight.rightClickPaste).toBe(false);
    expect(parsedCtrlRight.events[0]?.ctrl).toBe(true);
    expect(parsedCtrlRight.events[0]?.button).toBe(2);

    // 3. Mapa de líneas a links y validación de esquemas seguros (solo http y https, nunca file: ni comandos)
    const sampleLines = [
      'Sin links aquí',
      'Revisa https://cloud.google.com/vertex-ai y http://localhost:3000/test.',
      'No abras file:///C:/Windows/System32/cmd.exe nunca',
    ];
    const linkMap = buildLineLinkMap(sampleLines);
    expect(linkMap.has(0)).toBe(false);
    expect(linkMap.get(1)?.map((s) => s.url)).toEqual([
      'https://cloud.google.com/vertex-ai',
      'http://localhost:3000/test',
    ]);
    expect(linkMap.has(2)).toBe(false);

    expect(findLinkAtLineColumn(linkMap, 1, 10)).toBe(
      'https://cloud.google.com/vertex-ai',
    );
    expect(findLinkAtLineColumn(linkMap, 1, 50)).toBe(
      'http://localhost:3000/test',
    );

    expect(isSafeHttpUrl('https://cloud.google.com/vertex-ai')).toBe(true);
    expect(isSafeHttpUrl('http://localhost:3000')).toBe(true);
    expect(isSafeHttpUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(openExternalHttpUrl('file:///C:/test.txt')).toBe(false);

    writeTextToClipboard('Texto copiado de prueba');
    expect(getLastCopiedClipboardText()).toBe('Texto copiado de prueba');

    // 4. Cálculo del tramo de la barra de scroll y salto al hacer clic en la pista
    const noOverflow = computeScrollbarThumb({
      trackHeight: 20,
      contentHeight: 15,
      viewportHeight: 20,
      scrollTop: 0,
    });
    expect(noOverflow.hasOverflow).toBe(false);

    const midThumb = computeScrollbarThumb({
      trackHeight: 20,
      contentHeight: 100,
      viewportHeight: 20,
      scrollTop: 40, // a la mitad de maxScrollTop=80
    });
    expect(midThumb.hasOverflow).toBe(true);
    expect(midThumb.thumbHeight).toBe(4);
    expect(midThumb.thumbTop).toBe(8);

    const jumpedBottom = scrollTopFromScrollbarTrackRow(19, 20, 80);
    expect(jumpedBottom.scrollTop).toBe(80);
    expect(jumpedBottom.isAtBottom).toBe(true);

    // 5. Visibilidad del botón "ir al final" y contador de mensajes nuevos
    expect(
      shouldShowScrollToBottomButton({ scrollTop: 80, isAtBottom: true }, 80),
    ).toBe(false);
    expect(
      shouldShowScrollToBottomButton({ scrollTop: 30, isAtBottom: false }, 80),
    ).toBe(true);
    expect(formatScrollToBottomLabel(0)).toBe('ir al final');
    expect(formatScrollToBottomLabel(3)).toBe('ir al final (3 nuevos)');
  });
});
