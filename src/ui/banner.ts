import os from 'node:os';
import path from 'node:path';
import { getModelDefinition } from '../config/models.js';
import type { GlitchSettings } from '../config/settings.js';

/**
 * Logo pixel-art compacto de Glitch CLI (3 líneas, estilo mascota cyber-glitch como en Claude Code).
 */
export const GLITCH_MINI_LOGO_LINES: readonly string[] = [
  ' ▗▄▄▄▄▄▖ ',
  '▐█ ⚡ █▌',
  ' ▝▀▛▀▛▀▘ ',
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

export function formatClaudeStyleHeaderInfo(
  settings: GlitchSettings,
  version = '0.1.0',
  cwd: string = process.cwd(),
): { line1Title: string; line1Version: string; line2ModelAuth: string; line3Cwd: string } {
  const provider = settings.provider ?? 'vertex';
  const lang = settings.language ?? 'es';
  const def = getModelDefinition(settings.model, provider);

  const effortText =
    def.supportedEfforts.length > 0
      ? lang === 'en'
        ? `with ${settings.effort} effort`
        : `con esfuerzo ${settings.effort}`
      : lang === 'en'
        ? 'standard'
        : 'estándar';

  const authSource =
    provider === 'vertex'
      ? 'Vertex AI'
      : settings.custom?.baseUrl
        ? `Custom API (${settings.custom.baseUrl})`
        : 'Custom API';

  return {
    line1Title: 'Glitch CLI',
    line1Version: `v${version}`,
    line2ModelAuth: `${def.name} (1M context) ${effortText} · ${authSource}`,
    line3Cwd: path.resolve(cwd),
  };
}

export function formatStartupBanner(
  version = '0.1.0',
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

  const footerHint = `  ${dim}? para atajos · ← 1 agent · Salir: Ctrl+C${reset}`;

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
