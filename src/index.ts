#!/usr/bin/env node

import os from 'node:os';
import readline from 'node:readline';
import type { Content, Part } from '@google/genai';
import {
  formatAuthSummary,
  isAuthConfigured,
  loadSettings,
  saveSettings,
} from './config/settings.js';
import {
  LOCAL_GOOGLE_MODELS,
  listVertexGoogleModels,
  type ModelDefinition,
} from './config/models.js';
import { runAuthFlow } from './commands/auth.js';
import { runModelCommand } from './commands/model.js';
import { runEffortCommand } from './commands/effort.js';
import { runSettingsCommand } from './commands/settings.js';
import { toggleSubMode } from './permissions/permissions.js';
import { formatStatusBar } from './ui/statusBar.js';
import { createVertexGenAI, streamVertexChat } from './providers/vertex.js';

function createQuestionHelper(rl: readline.Interface) {
  return (promptText: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(promptText, (answer) => resolve(answer));
    });
}

function printHelp(): void {
  console.log('Comandos disponibles:');
  console.log('  /auth                     Configurar conexión (Vertex AI o API personalizada)');
  console.log('  /settings                 Panel de preferencias (modo, sub-modo, effort, thoughts)');
  console.log('  /model [id|num]           Seleccionar modelo disponible (bloqueado durante petición activa)');
  console.log('  /effort [low|medium|high] Ver o cambiar el nivel de effort del modelo actual');
  console.log('  /help                     Mostrar esta ayuda');
  console.log('  /exit                     Salir de Glitch CLI');
  console.log('Atajos de teclado:');
  console.log('  Shift+Tab / Alt+P         Alternar Sub-modo (Plan <-> Agent)');
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log('Glitch CLI v0.1.0');
    return;
  }

  console.log('⚡ Glitch CLI v0.1.0');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = createQuestionHelper(rl);

  let settings = loadSettings();
  const history: Content[] = [];
  let availableModels: ModelDefinition[] = [...LOCAL_GOOGLE_MODELS];
  let isRequestActive = false;

  // Atajo de teclado en vivo: Shift+Tab (\x1b[Z) o Alt+P (\x1bp) alterna Sub-modo Plan <-> Agent
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', (str: string, key?: readline.Key) => {
      const isShiftTab = key?.name === 'tab' && key?.shift === true;
      const isAltP = key?.name === 'p' && key?.meta === true;
      const isRawBacktab = str === '\x1b[Z';
      if (isShiftTab || isAltP || isRawBacktab) {
        const nextSubMode = toggleSubMode(settings.subMode);
        settings = { ...settings, subMode: nextSubMode };
        saveSettings(settings);
        process.stdout.write(
          `${os.EOL}⇄ Sub-modo cambiado a: ${nextSubMode === 'plan' ? 'Plan' : 'Agent'}${os.EOL}${formatStatusBar(settings)}${os.EOL}`,
        );
      }
    });
  }

  if (!isAuthConfigured(settings)) {
    console.log('Primera ejecución detectada: configura tu conexión.');
    settings = await runAuthFlow(settings, ask);
  } else {
    console.log(`Conectado: ${formatAuthSummary(settings)}`);
  }

  if (settings.provider === 'vertex' && settings.vertex) {
    try {
      const ai = createVertexGenAI(settings.vertex);
      availableModels = await listVertexGoogleModels(ai);
    } catch {
      availableModels = [...LOCAL_GOOGLE_MODELS];
    }
  }

  let running = true;
  while (running) {
    console.log(formatStatusBar(settings));
    const input = (await ask('glitch> ')).trim();
    if (!input) continue;

    if (input === '/exit') {
      console.log('Cerrando Glitch CLI...');
      running = false;
      break;
    }

    if (input === '/help') {
      printHelp();
      continue;
    }

    if (input === '/auth') {
      settings = await runAuthFlow(settings, ask);
      if (settings.provider === 'vertex' && settings.vertex) {
        try {
          const ai = createVertexGenAI(settings.vertex);
          availableModels = await listVertexGoogleModels(ai);
        } catch {
          availableModels = [...LOCAL_GOOGLE_MODELS];
        }
      }
      continue;
    }

    if (input === '/settings') {
      settings = await runSettingsCommand(settings, ask);
      continue;
    }

    if (input === '/model' || input.startsWith('/model ')) {
      const args = input.slice('/model'.length).trim();
      settings = await runModelCommand(
        settings,
        availableModels,
        isRequestActive,
        args,
        ask,
      );
      continue;
    }

    if (input === '/effort' || input.startsWith('/effort ')) {
      const args = input.slice('/effort'.length).trim();
      settings = runEffortCommand(settings, args);
      continue;
    }

    if (input.startsWith('/')) {
      console.log(
        `Comando desconocido: ${input}. Escribe /help para ver los comandos disponibles.`,
      );
      continue;
    }

    if (!isAuthConfigured(settings)) {
      console.log('⚠ Debes configurar la autenticación primero con /auth.');
      continue;
    }

    if (settings.provider === 'vertex' && settings.vertex) {
      isRequestActive = true;
      try {
        const ai = createVertexGenAI(settings.vertex);
        history.push({ role: 'user', parts: [{ text: input }] });
        process.stdout.write(os.EOL);
        const collectedParts: Part[] = [];
        let fullReply = '';
        for await (const chunk of streamVertexChat(
          ai,
          settings.model,
          history,
          {
            effort: settings.effort,
            includeThoughts: settings.thoughts,
            onParts: (parts) => collectedParts.push(...parts),
          },
        )) {
          process.stdout.write(chunk);
          fullReply += chunk;
        }
        process.stdout.write(os.EOL);
        history.push({
          role: 'model',
          parts:
            collectedParts.length > 0
              ? collectedParts
              : [{ text: fullReply }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`✗ Error en petición a Vertex AI: ${msg}`);
      } finally {
        isRequestActive = false;
      }
    } else {
      console.log(
        'ℹ El adaptador de API personalizada se activará en la Etapa 4.',
      );
    }
  }

  rl.close();
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('index.js') ||
    process.argv[1].endsWith('index.ts') ||
    process.argv[1].includes('glitch'));

if (isDirectExecution && !process.env['VITEST']) {
  main().catch((err) => {
    console.error('Error fatal:', err);
    process.exit(1);
  });
}
