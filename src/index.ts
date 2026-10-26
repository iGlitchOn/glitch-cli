#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { loadSettings } from './config/settings.js';
import { printHelpMenu } from './core/inputLoop.js';
import { TuiApp } from './ui/TuiApp.js';

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log('Glitch CLI v0.1.0');
    return;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelpMenu();
    return;
  }

  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  // Sin sandbox: acceso completo al PC desde cualquier directorio, con Always Allow (--DAA) por defecto
  const initialSettings = loadSettings(undefined, argv);
  const instance = render(
    React.createElement(TuiApp, { initialSettings, version: '0.1.0' }),
  );
  await instance.waitUntilExit();
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
