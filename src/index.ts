#!/usr/bin/env node

import os from 'node:os';
import readline from 'node:readline';
import type { Content } from '@google/genai';
import {
  formatAuthSummary,
  isAuthConfigured,
  loadSettings,
} from './config/settings.js';
import { runAuthFlow } from './commands/auth.js';
import { createVertexGenAI, streamVertexChat } from './providers/vertex.js';

function createQuestionHelper(rl: readline.Interface) {
  return (promptText: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(promptText, (answer) => resolve(answer));
    });
}

function printHelp(): void {
  console.log('Comandos disponibles:');
  console.log('  /auth   Configurar conexión (Vertex AI o API personalizada)');
  console.log('  /help   Mostrar esta ayuda');
  console.log('  /exit   Salir de Glitch CLI');
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

  if (!isAuthConfigured(settings)) {
    console.log('Primera ejecución detectada: configura tu conexión.');
    settings = await runAuthFlow(settings, ask);
  } else {
    console.log(`Conectado: ${formatAuthSummary(settings)}`);
  }

  let running = true;
  while (running) {
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
      try {
        const ai = createVertexGenAI(settings.vertex);
        history.push({ role: 'user', parts: [{ text: input }] });
        process.stdout.write(os.EOL);
        let fullReply = '';
        for await (const chunk of streamVertexChat(
          ai,
          settings.model,
          history,
        )) {
          process.stdout.write(chunk);
          fullReply += chunk;
        }
        process.stdout.write(os.EOL);
        history.push({ role: 'model', parts: [{ text: fullReply }] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`✗ Error en petición a Vertex AI: ${msg}`);
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
