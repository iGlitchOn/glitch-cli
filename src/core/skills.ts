import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SkillInfo {
  name: string;
  description: string;
  sourceLabel: string;
  filePath: string;
  approxTokens: number;
  content: string;
}

export interface SkillSubcommandHelp {
  subcommand: string;
  description: string;
}

export const SKILL_SUBCOMMANDS: readonly SkillSubcommandHelp[] = [
  {
    subcommand: '/skill list',
    description:
      'Lista todas las skills reales, de dónde vienen y sus ~tokens aprox.',
  },
  {
    subcommand: '/skill use <nombre>',
    description:
      'Activa una skill e inyecta su SKILL.md en el agente actual',
  },
  {
    subcommand: '/skill info <nombre>',
    description:
      'Muestra origen exacto, ruta en disco, ~tokens aprox. y resumen de la skill',
  },
  {
    subcommand: '/skill off <nombre>',
    description: 'Desactiva una skill activa en la sesión actual',
  },
  {
    subcommand: '/skill clear',
    description: 'Desactiva todas las skills activas de la sesión',
  },
];

function parseFrontmatterField(raw: string, field: string): string | undefined {
  const lf = String.fromCharCode(10);
  const cr = String.fromCharCode(13);
  const lines = raw.split(lf).map((l) => l.split(cr).join(''));
  const prefix = `${field.toLowerCase()}:`;
  for (const line of lines.slice(0, 25)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed
        .slice(prefix.length)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

export function discoverSkills(
  customHomeDir?: string,
  cwd: string = process.cwd(),
): SkillInfo[] {
  const home = customHomeDir ?? os.homedir();
  const candidateRoots: Array<{ dir: string; labelPrefix: string }> = [
    {
      dir: path.join(home, '.glitch', 'skills'),
      labelPrefix: '~/.glitch/skills',
    },
    {
      dir: path.join(cwd, '.agents', 'skills'),
      labelPrefix: './.agents/skills',
    },
    {
      dir: path.join(home, '.agents', 'skills'),
      labelPrefix: '~/.agents/skills',
    },
  ];

  const seen = new Set<string>();
  const skills: SkillInfo[] = [];

  for (const root of candidateRoots) {
    if (!fs.existsSync(root.dir)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root.dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      try {
        const content = fs.readFileSync(skillFile, 'utf-8');
        const name = parseFrontmatterField(content, 'name') || entry.name;
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        const lf = String.fromCharCode(10);
        const cr = String.fromCharCode(13);
        const allLines = content.split(lf).map((l) => l.split(cr).join(''));
        const desc =
          parseFrontmatterField(content, 'description') ||
          allLines
            .find(
              (l) =>
                l.trim() &&
                !l.trim().startsWith('#') &&
                !l.trim().startsWith('---') &&
                !l.includes(':'),
            )
            ?.trim() ||
          'Skill especializada disponible para Glitch CLI.';

        const approxTokens = Math.max(1, Math.ceil(content.length / 4));

        skills.push({
          name,
          description: desc.length > 140 ? `${desc.slice(0, 137)}...` : desc,
          sourceLabel: `${root.labelPrefix}/${entry.name}`,
          filePath: skillFile,
          approxTokens,
          content,
        });
      } catch {
        // Ignora archivos ilegibles
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export const discoverInstalledSkills = discoverSkills;

export function formatSkillTokens(tokens: number): string {
  return `~${tokens.toLocaleString('en-US')} tokens`;
}

export function executeSkillSubcommand(
  rawArgs: string,
  skills: readonly SkillInfo[],
  activeSkillNames: Set<string>,
  out: (msg: string) => void,
): { updatedActiveSkills: Set<string>; handled: boolean } {
  const nextActive = new Set(activeSkillNames);
  const trimmed = rawArgs.trim();

  if (!trimmed) {
    return { updatedActiveSkills: nextActive, handled: false };
  }

  const parts = trimmed.split(/\s+/);
  const sub = parts[0]!.toLowerCase();
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'list' || sub === 'ls') {
    if (skills.length === 0) {
      out(
        'No se encontraron skills instaladas en ~/.glitch/skills ni en ~/.agents/skills.',
      );
      return { updatedActiveSkills: nextActive, handled: true };
    }
    const totalTokens = skills.reduce((acc, s) => acc + s.approxTokens, 0);
    out(
      `=== Skills instaladas (${skills.length}) | Total: ${formatSkillTokens(totalTokens)} ===`,
    );
    for (const s of skills) {
      const state = nextActive.has(s.name) ? 'activa' : 'inactiva';
      out(
        `  - ${s.name.padEnd(28, ' ')} | Origen: ${s.sourceLabel.padEnd(36, ' ')} | ${formatSkillTokens(s.approxTokens).padEnd(16, ' ')} | ${state}`,
      );
    }
    return { updatedActiveSkills: nextActive, handled: true };
  }

  if (sub === 'clear' || sub === 'reset') {
    nextActive.clear();
    out('Todas las skills activas fueron desactivadas de la sesión actual.');
    return { updatedActiveSkills: nextActive, handled: true };
  }

  if (sub === 'info' || sub === 'show') {
    if (!rest) {
      out('Uso: /skill info <nombre-skill>');
      return { updatedActiveSkills: nextActive, handled: true };
    }
    const found = skills.find(
      (s) => s.name.toLowerCase() === rest.toLowerCase(),
    );
    if (!found) {
      out(`No existe la skill "${rest}". Usa /skills para ver la lista.`);
      return { updatedActiveSkills: nextActive, handled: true };
    }
    out(`=== Skill: ${found.name} ===`);
    out(`  De dónde viene : ${found.sourceLabel}`);
    out(`  Ruta en disco  : ${found.filePath}`);
    out(`  Tokens aprox.  : ${formatSkillTokens(found.approxTokens)}`);
    out(
      `  Estado actual  : ${nextActive.has(found.name) ? 'activa' : 'inactiva'}`,
    );
    out(`  Descripción    : ${found.description}`);
    return { updatedActiveSkills: nextActive, handled: true };
  }

  if (sub === 'off' || sub === 'disable' || sub === 'deactivate') {
    if (!rest) {
      out('Uso: /skill off <nombre-skill>');
      return { updatedActiveSkills: nextActive, handled: true };
    }
    const found = skills.find(
      (s) => s.name.toLowerCase() === rest.toLowerCase(),
    );
    const key = found ? found.name : rest;
    if (nextActive.delete(key)) {
      out(`Skill "${key}" desactivada.`);
    } else {
      out(`La skill "${key}" no estaba activa.`);
    }
    return { updatedActiveSkills: nextActive, handled: true };
  }

  const targetName =
    sub === 'use' || sub === 'activate' || sub === 'on' ? rest : trimmed;
  const found = skills.find(
    (s) => s.name.toLowerCase() === targetName.toLowerCase(),
  );
  if (!found) {
    out(
      `No se encontró la skill "${targetName}". Subcomandos: /skill list | /skill use <nombre> | /skill info <nombre> | /skill off <nombre> | /skill clear`,
    );
    return { updatedActiveSkills: nextActive, handled: true };
  }

  if (nextActive.has(found.name)) {
    nextActive.delete(found.name);
    out(
      `Skill "${found.name}" desactivada (${found.sourceLabel}, ${formatSkillTokens(found.approxTokens)}).`,
    );
  } else {
    nextActive.add(found.name);
    out(
      `Skill "${found.name}" activada desde ${found.sourceLabel} (${formatSkillTokens(found.approxTokens)}).`,
    );
  }
  return { updatedActiveSkills: nextActive, handled: true };
}
