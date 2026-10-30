import os from 'node:os';
import path from 'node:path';
import { getModelDefinition } from '../config/models.js';
import {
  formatPermissionModeLabel,
  formatSubModeLabel,
  getAppVersion,
  type EffortLevel,
  type GlitchSettings,
} from '../config/settings.js';
export const GLITCH_MINI_LOGO_LINES: readonly string[] = [
  ' [====] ',
  ' | GL | ',
  ' [====] ',
];
export const IGLITCHOFF_WORDMARK = GLITCH_MINI_LOGO_LINES.join(os.EOL);
export const GLITCH_ASCII_LINES: readonly string[] = [
  '--------------------------------------------------------------------------------',
  '-------------------------------====-----=*#%%#+=--------------------------------',
  '---------------------------=**.....-#=+#.......:#=-=++**+=----------------------',
  '--------------------+***+==*..:----:.=+...=-..-..#+......:#=--------------------',
  '-----------------+*:.....:%:.:-..:*-:.-..:..........===....*=*****=-------------',
  '----------------*:..=+++...+......+-.....:-......=.+.::=..:+......:%=-----------',
  '---------------++.-+-#:.:=.-#+::+++#-:.....=+--*=:-%..=**=+....:+...*-----------',
  '-----------*#-.=#.==+......-=---==..-*==*:..*...*=-#.......=....+...+=----------',
  '---------=%-=*+*...*++-...*-.-+-*.-:......-*...=+...=.=**:.-*--....:*=*%=-------',
  '---------+==*--+::-:.:=...:-:...*.=........=...:+=-*:.....*-....::...:...#=-----',
  '---------=%+--:==.....+.+-...:+.:+.+:..=...+.....-+-......-+..*...==...*.:*-----',
  '-------**-=+=--+......+.+.....*.:#*.......*+-+=....*-....-+*..:-..-:...+.:#-----',
  '------#-=*-==--=*=-=*%..-=.:-:.:#-:=*****=-..=-=+..:%*++**--*+-:=#:..-:..*=-----',
  '-----*+-++--%*-------#....%*#**-:....::.....-+.+:..#-:--::..::---%....:=--*-----',
  '-----++---==-*----=#-:#:..-+::...............-*###+-.......#@+...-*-.....:*-----',
  '------+%----#=#==#*...:+..++......:@@@@@@#............%@@@@=.......=+..:#*------',
  '------#=----*+----*......-+-.....-@-................................*..:*-------',
  '-----=*----*#------=#==*#--:........*@@@@@@@........%@@@@@@%........*.:*=-------',
  '------=#*+*--*+++=-*:.-*............*@@@@@@@........%@@@@@@%........*.*=--------',
  '------=*@@@@#+--=+....*-............*@@@@%-.........%@@@@#:.........+%%%%+------',
  '-----%%=----:=#*+.:..=+:............*@@@#-..........%@@@*:..........-*---+%-----',
  '----#%--=##+-:-+=.....*:............*@@@@@@%........%@@@@@@*........-%%*+:%*----',
  '----@---+++#@*--=#-:+#-:............*@@@@@@%........%@@@@@@#........:@+*=-+#----',
  '----@:-=-=+++%*--------:...........:@@%**#@@=....%-*@@@@@@@%........:@*=--+#----',
  '----@=---++%@+@-----:---.......................-=....+..............-*+*--%*----',
  '----*@----+@------------............................................=*#--=@=----',
  '-----%%----=%#+---=-----:.......:@@@@:..............................+---+@=-----',
  '------*@*-------==+=::::-.......:@@@@:..............................*=+##-------',
  '--------*@%#**#%++++=----........---+@%*+=:...........:=#-..........%*+---------',
  '-----------===-*#++++=---:..........=@@@@@@@@@@@@@@@@@:............*+-----------',
  '----------------+*+++++--:...........:=*%@@@@@@@@@@@@@:...........-*------------',
  '-----------------=%++++++=:......................................-#-------------',
  '-------------------##++++++=...............::..:-:.............:#+--------------',
  '---------------------##++++++++-.............:-:.............=*#----------------',
  '-----------------------=##+++++++++=:....................-+*%*------------------',
  '---------------------------+##*+++++++++++==------==+++*##+---------------------',
  '--------------------------------+*##%%##*******##%##*+=-------------------------',
  '--------------------------------------------------------------------------------',
  '--------------------------------------------------------------------------------',
  '--------------------------------------------------------------------------------',
];
export const GLITCH_ASCII_ART = GLITCH_ASCII_LINES.join(os.EOL);
export function formatShortCwd(cwd: string = process.cwd()): string {
  const home = os.homedir();
  const normalizedHome = path.resolve(home);
  const normalizedCwd = path.resolve(cwd);
  if (normalizedCwd.toLowerCase() === normalizedHome.toLowerCase()) {
    return '~';
  }
  if (
    normalizedCwd
      .toLowerCase()
      .startsWith(normalizedHome.toLowerCase() + path.sep)
  ) {
    return '~' + normalizedCwd.slice(normalizedHome.length);
  }
  return normalizedCwd;
}
export function isWindowsSystemDirectory(cwd: string = process.cwd()): boolean {
  const normalized = path.resolve(cwd).replace(/\//g, '\\').toLowerCase();
  return (
    normalized === 'c:\\windows' ||
    normalized.startsWith('c:\\windows\\system32') ||
    normalized.startsWith('c:\\windows\\syswow64') ||
    /^[a-z]:\\windows(\\(system32|syswow64)(\\.*)?)?$/i.test(normalized)
  );
}
export function formatEffortDisplayLabel(effort: EffortLevel): string {
  if (effort === 'low') return 'Bajo';
  if (effort === 'medium') return 'Medio';
  return 'Alto';
}
export function formatClaudeStyleHeaderInfo(
  settings: GlitchSettings,
  version = getAppVersion(),
): {
  line1Title: string;
  line1Version: string;
  line2ModelAuth: string;
  line3ModeSubMode: string;
} {
  const provider = settings.provider ?? 'vertex';
  const def = getModelDefinition(settings.model, provider);
  const effectiveEffort =
    def.supportedEfforts.length > 0
      ? def.supportedEfforts.includes(settings.effort)
        ? settings.effort
        : (def.defaultEffort ?? def.supportedEfforts[0]!)
      : undefined;
  const effortSegment = effectiveEffort
    ? ` | Esfuerzo: ${formatEffortDisplayLabel(effectiveEffort)}`
    : '';
  const authSource =
    provider === 'vertex'
      ? 'Vertex AI'
      : settings.custom?.baseUrl
        ? `Custom API (${settings.custom.baseUrl})`
        : 'Custom API';
  const modeLabel = formatPermissionModeLabel(settings.permissionMode);
  const subModeLabel = formatSubModeLabel(settings.subMode);
  return {
    line1Title: 'Glitch CLI',
    line1Version: `v${version}`,
    line2ModelAuth: `${def.name}${effortSegment} · ${authSource}`,
    line3ModeSubMode: `${modeLabel} · Sub-Modo: ${subModeLabel}`,
  };
}
export function formatStartupBanner(
  version = getAppVersion(),
  terminalColumns = process.stdout.columns || 100,
  cwd: string = process.cwd(),
): string {
  const artWidth = GLITCH_ASCII_LINES[0]?.length ?? 80;
  const leftPadCount = Math.max(0, Math.floor((terminalColumns - artWidth) / 2));
  const pad = ' '.repeat(leftPadCount);
  const dim = '\x1b[90m';
  const boldWhite = '\x1b[1;97m';
  const cyan = '\x1b[36m';
  const reset = '\x1b[0m';
  const headerLine1 = `  ${cyan}${GLITCH_MINI_LOGO_LINES[0]}${reset}  ${boldWhite}>_ Glitch CLI${reset} ${dim}(v${version})${reset}`;
  const headerLine2 = `  ${cyan}${GLITCH_MINI_LOGO_LINES[1]}${reset}  ${dim}${formatShortCwd(cwd)}${reset}`;
  const headerLine3 = `  ${cyan}${GLITCH_MINI_LOGO_LINES[2]}${reset}`;
  const centeredArt = GLITCH_ASCII_LINES.map(
    (line) => `${pad}${dim}${line}${reset}`,
  ).join(os.EOL);
  const footerHint = `  ${dim}? para atajos | Agentes | Salir: Ctrl+C${reset}`;
  return [
    '',
    headerLine1,
    headerLine2,
    headerLine3,
    '',
    centeredArt,
    '',
    footerHint,
    '',
  ].join(os.EOL);
}
