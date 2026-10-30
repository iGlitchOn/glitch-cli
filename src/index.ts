#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import {
  getAppVersion,
  hasAlwaysAllowFlag,
  hasSameWindowFlag,
  loadSettings,
  parseMessageFlag,
  parseModelFlag,
} from './config/settings.js';
import { printHelpMenu } from './commands/slashRegistry.js';
import { spawnGlitchTerminalWindow } from './core/tools.js';
import { TuiApp } from './ui/TuiApp.js';

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const version = getAppVersion();

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(`Glitch CLI v${version}`);
    return;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelpMenu(console.log, version);
    return;
  }

  const inSpawnedWindow =
    hasSameWindowFlag(argv) || process.env['GLITCH_IN_SPAWNED_WINDOW'] === '1';
  const envInitialMessage = process.env['GLITCH_INITIAL_MESSAGE']?.trim();
  delete process.env['GLITCH_IN_SPAWNED_WINDOW'];
  delete process.env['GLITCH_INITIAL_MESSAGE'];

  const initialPrompt = envInitialMessage || parseMessageFlag(argv);
  const launchedWithDaaFlag = hasAlwaysAllowFlag(argv);
  const cliModel = parseModelFlag(argv);

  if (initialPrompt && !inSpawnedWindow && !process.env['VITEST']) {
    const res = spawnGlitchTerminalWindow({
      message: initialPrompt,
      cwd: process.cwd(),
      daa: launchedWithDaaFlag,
      model: cliModel,
    });
    if (res.error) {
      console.error(res.error);
      process.exitCode = 1;
    } else if (res.result) {
      console.log(res.result);
    }
    return;
  }

  const initialSettings = loadSettings(undefined, argv);
  const instance = render(
    React.createElement(TuiApp, {
      initialSettings,
      version,
      launchedWithDaaFlag,
      initialPrompt,
    }),
    {
      exitOnCtrlC: false,
      alternateScreen: true,
      incrementalRendering: true,
      maxFps: 120,
      kittyKeyboard: { mode: 'auto' },
    },
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
