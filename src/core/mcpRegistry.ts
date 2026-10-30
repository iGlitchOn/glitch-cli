import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface McpCommandItem {
  name: string;
  summary: string;
}

export interface McpServerEntry {
  id: string;
  source: string;
  configPath: string;
  commandLine: string;
  description: string;
  commands: McpCommandItem[];
  active?: boolean;
}

const KNOWN_MCP_CATALOG: Record<
  string,
  { description: string; commands: McpCommandItem[] }
> = {
  blender: {
    description:
      'Controla una sesión en vivo de Blender 3D mediante Python (bpy), inspección de escena, cámara y generación/importación de assets 3D.',
    commands: [
      { name: 'get_addon_status', summary: 'Verifica la versión de Blender y generadores 3D activos' },
      { name: 'get_scene_info', summary: 'Inspecciona objetos, tamaños, topología y jerarquía de la escena' },
      { name: 'look', summary: 'Captura imagen del viewport o cámara desde distintos ángulos' },
      { name: 'execute_blender_code', summary: 'Ejecuta código Python (bpy / bmesh) en vivo dentro de Blender' },
      { name: 'search_assets', summary: 'Busca modelos, texturas y HDRIs en Poly Haven, Sketchfab y Poly Pizza' },
      { name: 'import_asset', summary: 'Descarga e importa un asset 3D o material directamente en la escena' },
      { name: 'generate_3d', summary: 'Genera un modelo 3D texturizado a partir de texto o imagen' },
      { name: 'record_trajectory_feedback', summary: 'Registra feedback de aceptación o corrección del paso actual' },
    ],
  },
  'rbx-studio': {
    description:
      'Conecta con Roblox Studio en vivo para explorar el DataModel, leer/editar scripts Luau, crear instancias, ejecutar playtests y tomar capturas.',
    commands: [
      { name: 'studio_status', summary: 'Estado de Roblox Studio conectado, modo edit/play y scripts abiertos' },
      { name: 'list_studios / set_active_studio', summary: 'Lista ventanas de Studio conectadas y elige la activa' },
      { name: 'tree / find / inspect', summary: 'Recorre jerarquía, busca por clase/tag y lee propiedades del DataModel' },
      { name: 'script_read / script_edit / script_create / script_grep', summary: 'Lee, busca, crea y edita scripts Luau en vivo' },
      { name: 'create / modify / delete / move', summary: 'Crea, modifica, mueve o destruye instancias con soporte de Undo' },
      { name: 'viewport / screenshot', summary: 'Enfoca cámara, lanza raycasts, audita UI y toma capturas del viewport' },
      { name: 'playtest / character / input', summary: 'Inicia/detiene playtests, mueve el personaje y simula teclado/mouse' },
      { name: 'console / debug / performance', summary: 'Lee logs de salida, breakpoints, memoria y profiler de scripts' },
      { name: 'terrain / geometry / collision / audio', summary: 'Edita terreno, CSG/booleanos, grupos de colisión y grafo de audio' },
      { name: 'assets / datastore / universe / sync', summary: 'Busca/sube assets, inspecciona DataStores y sincroniza scripts a disco' },
    ],
  },
  'claude-code': {
    description:
      'Puente nativo ConPTY en Windows hacia sesiones CLI interactivas para leer pantalla en RAM, estado de thinking y aprobar prompts.',
    commands: [
      { name: 'session_start / session_list / session_resume', summary: 'Inicia, lista o retoma sesiones CLI nativas en ConPTY' },
      { name: 'send / read', summary: 'Envía comandos de texto y lee salida y métricas de thinking en tiempo real' },
      { name: 'pending_approval / approve', summary: 'Detecta y responde prompts numerados de confirmación' },
      { name: 'interrupt / session_close', summary: 'Envía Ctrl+C / Escape o cierra la sesión activa' },
    ],
  },
};

function matchKnownMcpMetadata(id: string): {
  description: string;
  commands: McpCommandItem[];
} {
  const lower = id.toLowerCase();
  if (lower.includes('blender')) {
    return KNOWN_MCP_CATALOG['blender']!;
  }
  if (lower.includes('rbx') || lower.includes('roblox') || lower.includes('studio')) {
    return KNOWN_MCP_CATALOG['rbx-studio']!;
  }
  if (lower.includes('claude')) {
    return KNOWN_MCP_CATALOG['claude-code']!;
  }
  return {
    description: `Servidor MCP "${id}" configurado localmente para exponer herramientas y recursos al agente.`,
    commands: [
      {
        name: `${id}:list_tools`,
        summary: 'Lista las herramientas expuestas por este servidor MCP al iniciar sesión',
      },
      {
        name: `${id}:call_tool`,
        summary: 'Ejecuta una herramienta del servidor MCP con argumentos JSON validados',
      },
      {
        name: `${id}:list_resources`,
        summary: 'Consulta los recursos de contexto expuestos por el servidor MCP',
      },
    ],
  };
}

export function discoverMcpServers(
  customHomeDir?: string,
  cwd: string = process.cwd(),
): McpServerEntry[] {
  const home = customHomeDir ?? os.homedir();
  const configFiles: Array<{ filePath: string; label: string }> = [
    { filePath: path.join(home, '.glitch', 'settings.json'), label: '~/.glitch/settings.json' },
    { filePath: path.join(cwd, '.mcp.json'), label: './.mcp.json' },
    { filePath: path.join(home, '.gemini', 'settings.json'), label: '~/.gemini/settings.json' },
    { filePath: path.join(home, '.claude.json'), label: '~/.claude.json' },
  ];

  const found = new Map<string, McpServerEntry>();

  for (const cfg of configFiles) {
    if (!fs.existsSync(cfg.filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(cfg.filePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const serversObj =
        parsed['mcpServers'] && typeof parsed['mcpServers'] === 'object'
          ? (parsed['mcpServers'] as Record<string, Record<string, unknown>>)
          : undefined;
      if (!serversObj) continue;

      for (const [serverId, rawDef] of Object.entries(serversObj)) {
        if (found.has(serverId)) continue;
        const cmd = typeof rawDef?.['command'] === 'string' ? rawDef['command'] : '';
        const args = Array.isArray(rawDef?.['args'])
          ? (rawDef['args'] as unknown[]).map(String).join(' ')
          : '';
        const url =
          typeof rawDef?.['url'] === 'string'
            ? rawDef['url']
            : typeof rawDef?.['httpUrl'] === 'string'
              ? rawDef['httpUrl']
              : '';
        const commandLine = url || `${cmd} ${args}`.trim() || 'stdio';
        const meta = matchKnownMcpMetadata(serverId);

        const isDisabled =
          rawDef?.['disabled'] === true || rawDef?.['enabled'] === false;
        const isConnectedInSession =
          rawDef?.['active'] === true || rawDef?.['connected'] === true;

        found.set(serverId, {
          id: serverId,
          source: cfg.label,
          configPath: cfg.filePath,
          commandLine,
          description: meta.description,
          commands: meta.commands,
          active: !isDisabled && isConnectedInSession,
        });
      }
    } catch {
      // Ignora archivos con JSON inválido
    }
  }

  return Array.from(found.values());
}
