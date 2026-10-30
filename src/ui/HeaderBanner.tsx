import React from 'react';
import { Box, Text } from 'ink';
import type { GlitchSettings } from '../config/settings.js';
import {
  formatShortCwd,
  isWindowsSystemDirectory,
} from './banner.js';

export interface HeaderBannerProps {
  settings: GlitchSettings;
  version: string;
  cwd?: string;
}

export const HeaderBanner: React.FC<HeaderBannerProps> = React.memo(({
  version,
  cwd = process.cwd(),
}) => {
  const shortCwd = formatShortCwd(cwd);
  const inSystemDir = isWindowsSystemDirectory(cwd);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text bold color="cyan">
            {'Glitch CLI'}
          </Text>
          <Text color="gray" dimColor>
            {`  v${version}`}
          </Text>
        </Box>
        <Text color="gray" dimColor>
          {shortCwd}
        </Text>
      </Box>
      {inSystemDir && (
        <Text color="gray" dimColor>
          {`estas en ${cwd}`}
        </Text>
      )}
    </Box>
  );
});
