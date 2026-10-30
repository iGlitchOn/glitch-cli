import {
  CURRENT_PRICING_VERSION,
  applyModelPriceEdit,
  formatEffortValueEs,
  formatPermissionModeLabel,
  formatSubModeLabel,
  notifyUnchanged,
  resolveBooleanSettingAlias,
  resolveEffortAlias,
  resolvePermissionModeAlias,
  resolveSubModeAlias,
  saveSettings,
  validateAutoCompactThreshold,
  type EffortLevel,
  type GlitchSettings,
  type PermissionMode,
  type SubMode,
} from '../config/settings.js';
import type { OutputFn, QuestionFn } from './auth.js';

export interface SettingHelpDetail {
  title: string;
  availableModesLabel: string;
  availableModes: string;
  whatItDoesLabel: string;
  whatItDoes: string;
}

export function getSettingHelpDetail(cursorIndex: number): SettingHelpDetail {
  const detailsEs: SettingHelpDetail[] = [
    {
      title: 'Modo de permisos',
      availableModesLabel: 'Modos disponibles:',
      availableModes: 'Always Allow, Ask only insecure, Always Ask',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Controla cuándo Glitch CLI pide confirmación antes de ejecutar una acción (permitir siempre, preguntar solo en acciones inseguras o preguntar siempre).',
    },
    {
      title: 'Sub-Modo',
      availableModesLabel: 'Modos disponibles:',
      availableModes: 'Plan, Agente',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'En Plan solo analiza y diseña sin modificar nada; en Agente puede ejecutar cambios directamente (atajo rápido: Shift+Tab).',
    },
    {
      title: 'Esfuerzo por defecto',
      availableModesLabel: 'Modos disponibles:',
      availableModes: 'LOW, MEDIUM, HIGH',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Define el nivel de razonamiento (thinkingLevel / reasoning_effort) que usará el modelo en cada respuesta.',
    },
    {
      title: 'Thoughts (Pensamientos)',
      availableModesLabel: 'Modos disponibles:',
      availableModes: 'Activa (ON), Desactivada (OFF)',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Muestra u oculta el bloque de razonamiento interno del modelo mientras piensa la respuesta.',
    },
    {
      title: 'Advertencia --DAA al inicio',
      availableModesLabel: 'Modos disponibles:',
      availableModes: 'Activa (ON), Desactivada (OFF)',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Desactiva o activa la alerta de seguridad de 3 segundos al iniciar con la bandera --DAA / --dangerously-always-allow.',
    },
    {
      title: 'Preguntas de la IA (ask_user)',
      availableModesLabel: 'Modos disponibles:',
      availableModes: 'Activa (ON), Modo Ausente / AFK (OFF)',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'En ON, la IA puede usar ask_user y notificarte cuando tenga una duda importante. En OFF (modo ausente / AFK para tareas largas sin supervisión), tiene prohibido detenerse a preguntar y debe tomar la mejor decisión autónoma y continuar.',
    },
    {
      title: 'Autocompactación',
      availableModesLabel: 'Modos disponibles:',
      availableModes: 'Activado (ON), Desactivado (OFF)',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Cuando el contexto usado alcanza el umbral configurado, pausa la tarea actual, lanza un sub-agente dedicado para resumir el historial y reanuda el trabajo sin perder el hilo.',
    },
    {
      title: 'Umbral de autocompactación',
      availableModesLabel: 'Rango permitido:',
      availableModes: '10 a 95 (% de contexto usado, solo enteros, por defecto 70)',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Define el porcentaje de contexto USADO a partir del cual se dispara la autocompactación. Presiona Enter para escribir un número entero entre 10 y 95.',
    },
    {
      title: 'Visualización de pensamiento (thinkingDisplay)',
      availableModesLabel: 'Modos disponibles:',
      availableModes: 'expandido, contraido, auto',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'expandido muestra el pensamiento completo; contraido muestra solo la primera línea real; auto lo muestra completo mientras genera y lo pliega a su primera línea al terminar.',
    },
    {
      title: 'Modelo resumidor de bloques (thinkingSummaryModel)',
      availableModesLabel: 'Por defecto:',
      availableModes: 'gemini-3.1-pro-preview',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Modelo encargado de redactar el resumen corto (máximo 60 palabras) al cerrar un bloque de pensamiento.',
    },
    {
      title: 'Límite de pasos de subagentes (subagentMaxSteps)',
      availableModesLabel: 'Por defecto:',
      availableModes: '0 (sin límite) o entero positivo',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Define el máximo de pasos por subagente. 0 significa sin límite de pasos; si se configura un límite y el subagente lo agota, queda en estado limite.',
    },
    {
      title: 'Recargo regional (regionalSurchargePct)',
      availableModesLabel: 'Por defecto:',
      availableModes: '0% (ej. 10% para endpoints regionales de Vertex AI)',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Aplica un porcentaje adicional al costo calculado cuando se usan endpoints regionales.',
    },
    {
      title: `Tabla de precios editable (pricingVersion v${CURRENT_PRICING_VERSION})`,
      availableModesLabel: 'Formato:',
      availableModes: 'entrada / salida / caché (USD por millón de tokens)',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Permite editar los precios por millón de tokens de cualquier modelo y registra el modelo en pricingEditedModels para conservarlo en migraciones.',
    },
    {
      title: 'Atajo de pensamiento (toggleThoughtsShortcut)',
      availableModesLabel: 'Atajos disponibles:',
      availableModes: 'ctrl+t, alt+t',
      whatItDoesLabel: '¿Qué hace?',
      whatItDoes:
        'Atajo de teclado para plegar o expandir los bloques de pensamiento en el chat.',
    },
  ];

  return detailsEs[cursorIndex] ?? detailsEs[0]!;
}

const PERMISSION_OPTIONS: Array<{ id: PermissionMode; label: string }> = [
  { id: 'always_allow', label: 'Always Allow' },
  { id: 'ask_insecure', label: 'Ask only insecure' },
  { id: 'always_ask', label: 'Always Ask' },
];

const SUBMODE_OPTIONS: Array<{ id: SubMode; label: string }> = [
  { id: 'plan', label: 'Plan (solo planear, no modifica nada)' },
  { id: 'agent', label: 'Agente (puede modificar directamente)' },
];

const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high'];

export function applySettingOptionValue(
  currentSettings: GlitchSettings,
  optionKeyOrNumber: string,
  rawValue: string,
  out: OutputFn = console.log,
  customHomeDir?: string,
  allowEmptyToggle = false,
): { settings: GlitchSettings; changed: boolean } {
  const key = optionKeyOrNumber.trim().toLowerCase();
  const val = rawValue.trim();
  const updated: GlitchSettings = { ...currentSettings };

  // 1) Modo de permisos
  if (
    key === '1' ||
    key === 'modo' ||
    key === 'mode' ||
    key === 'permisos' ||
    key === 'permission' ||
    key === 'permissionmode' ||
    key === 'permission_mode'
  ) {
    const picked = resolvePermissionModeAlias(val);
    if (!picked) {
      out(
        'Selección de modo inválida. Valores permitidos: Always Allow, Ask only insecure, Always Ask.',
      );
      return { settings: currentSettings, changed: false };
    }
    if (picked === currentSettings.permissionMode) {
      notifyUnchanged(
        'modo de permisos',
        formatPermissionModeLabel(picked),
        out,
      );
      return { settings: currentSettings, changed: false };
    }
    const prevLabel = formatPermissionModeLabel(currentSettings.permissionMode);
    const nextLabel = formatPermissionModeLabel(picked);
    updated.permissionMode = picked;
    saveSettings(updated, customHomeDir);
    out(
      `Modo de permisos cambiado de ${prevLabel} a ${nextLabel} (actualizado a: ${nextLabel}).`,
    );
    return { settings: updated, changed: true };
  }

  // 2) Sub-Modo (Plan / Agente)
  if (
    key === '2' ||
    key === 'submodo' ||
    key === 'sub-modo' ||
    key === 'submode' ||
    key === 'sub_mode'
  ) {
    const picked = resolveSubModeAlias(val);
    if (!picked) {
      out('Selección de sub-modo inválida. Valores permitidos: Plan, Agente.');
      return { settings: currentSettings, changed: false };
    }
    if (picked === currentSettings.subMode) {
      notifyUnchanged('sub-modo', formatSubModeLabel(picked), out);
      return { settings: currentSettings, changed: false };
    }
    const prevEs = formatSubModeLabel(currentSettings.subMode);
    const nextEs = formatSubModeLabel(picked);
    updated.subMode = picked;
    saveSettings(updated, customHomeDir);
    out(
      `Sub-Modo cambiado de ${prevEs} a ${nextEs} (actualizado a: ${picked === 'plan' ? 'Plan' : 'Agent'}).`,
    );
    return { settings: updated, changed: true };
  }

  // 3) Esfuerzo por defecto
  if (key === '3' || key === 'esfuerzo' || key === 'effort') {
    const byIdx = Number.parseInt(val, 10) - 1;
    const picked =
      !Number.isNaN(byIdx) && byIdx >= 0 && byIdx < EFFORT_OPTIONS.length
        ? EFFORT_OPTIONS[byIdx]!
        : resolveEffortAlias(val);
    if (!picked) {
      out(
        'Nivel de esfuerzo inválido. Valores permitidos: Bajo (low), Medio (medium), Alto (high).',
      );
      return { settings: currentSettings, changed: false };
    }
    if (picked === currentSettings.effort) {
      notifyUnchanged('esfuerzo', formatEffortValueEs(picked), out);
      return { settings: currentSettings, changed: false };
    }
    const prevEs = formatEffortValueEs(currentSettings.effort);
    const nextEs = formatEffortValueEs(picked);
    updated.effort = picked;
    saveSettings(updated, customHomeDir);
    out(
      `Esfuerzo por defecto cambiado de ${prevEs} a ${nextEs} (${picked.toUpperCase()}).`,
    );
    return { settings: updated, changed: true };
  }

  // 4) Thoughts
  if (key === '4' || key === 'thoughts' || key === 'pensamientos') {
    const picked =
      !val && allowEmptyToggle
        ? !currentSettings.thoughts
        : resolveBooleanSettingAlias(val);
    if (picked === null) {
      out(
        'Valor inválido para Thoughts. Valores permitidos: Activado (on), Desactivado (off).',
      );
      return { settings: currentSettings, changed: false };
    }
    if (picked === currentSettings.thoughts) {
      notifyUnchanged('thoughts', picked ? 'Activado' : 'Desactivado', out);
      return { settings: currentSettings, changed: false };
    }
    const prevEs = currentSettings.thoughts ? 'Activado' : 'Desactivado';
    const nextEs = picked ? 'Activado' : 'Desactivado';
    updated.thoughts = picked;
    saveSettings(updated, customHomeDir);
    out(
      `Thoughts cambiado de ${prevEs} a ${nextEs} (actualizado a: ${picked ? 'ON' : 'OFF'}).`,
    );
    return { settings: updated, changed: true };
  }

  // 5) Advertencia --DAA al inicio
  if (
    key === '5' ||
    key === 'daa' ||
    key === 'advertencia' ||
    key === 'daawarning' ||
    key === 'hidedaawarning'
  ) {
    const currentWarningOn = !currentSettings.hideDaaWarning;
    const targetWarningOn =
      !val && allowEmptyToggle
        ? !currentWarningOn
        : resolveBooleanSettingAlias(val);
    if (targetWarningOn === null) {
      out(
        'Valor inválido para Advertencia --DAA. Valores permitidos: Activada (on), Desactivada (off).',
      );
      return { settings: currentSettings, changed: false };
    }
    if (targetWarningOn === currentWarningOn) {
      notifyUnchanged(
        'advertencia --DAA',
        targetWarningOn ? 'Activada' : 'Desactivada',
        out,
      );
      return { settings: currentSettings, changed: false };
    }
    const prevEs = currentWarningOn ? 'Activada' : 'Desactivada';
    const nextEs = targetWarningOn ? 'Activada' : 'Desactivada';
    updated.hideDaaWarning = !targetWarningOn;
    saveSettings(updated, customHomeDir);
    out(
      `Advertencia --DAA al inicio cambiada de ${prevEs} a ${nextEs} (actualizada a: ${targetWarningOn ? 'ON' : 'OFF'}).`,
    );
    return { settings: updated, changed: true };
  }

  // 6) Preguntas de la IA (ask_user)
  if (
    key === '6' ||
    key === 'ask_user' ||
    key === 'preguntas' ||
    key === 'allowagentquestions'
  ) {
    const currentAllow = currentSettings.allowAgentQuestions ?? true;
    const targetAllow =
      !val && allowEmptyToggle
        ? !currentAllow
        : resolveBooleanSettingAlias(val);
    if (targetAllow === null) {
      out(
        'Valor inválido para Preguntas de la IA. Valores permitidos: Activadas (on), Desactivadas (off).',
      );
      return { settings: currentSettings, changed: false };
    }
    if (targetAllow === currentAllow) {
      notifyUnchanged(
        'preguntas de la IA',
        targetAllow ? 'Activadas' : 'Desactivadas',
        out,
      );
      return { settings: currentSettings, changed: false };
    }
    const prevEs = currentAllow ? 'Activadas' : 'Desactivadas';
    const nextEs = targetAllow ? 'Activadas' : 'Desactivadas';
    updated.allowAgentQuestions = targetAllow;
    saveSettings(updated, customHomeDir);
    out(
      `Preguntas de la IA (ask_user) cambiadas de ${prevEs} a ${nextEs} (actualizada a: ${targetAllow ? 'ON' : 'OFF'}).`,
    );
    return { settings: updated, changed: true };
  }

  // 7) Autocompactación
  if (
    key === '7' ||
    key === 'autocompact' ||
    key === 'autocompactacion' ||
    key === 'autocompactación'
  ) {
    const currentAuto = currentSettings.autoCompact ?? true;
    const targetAuto =
      !val && allowEmptyToggle
        ? !currentAuto
        : resolveBooleanSettingAlias(val);
    if (targetAuto === null) {
      out(
        'Valor inválido para Autocompactación. Valores permitidos: Activada (on), Desactivada (off).',
      );
      return { settings: currentSettings, changed: false };
    }
    if (targetAuto === currentAuto) {
      notifyUnchanged(
        'autocompactación',
        targetAuto ? 'Activada' : 'Desactivada',
        out,
      );
      return { settings: currentSettings, changed: false };
    }
    const prevEs = currentAuto ? 'Activada' : 'Desactivada';
    const nextEs = targetAuto ? 'Activada' : 'Desactivada';
    updated.autoCompact = targetAuto;
    saveSettings(updated, customHomeDir);
    out(
      `Autocompactación cambiada de ${prevEs} a ${nextEs} (actualizada a: ${targetAuto ? 'ON' : 'OFF'}).`,
    );
    return { settings: updated, changed: true };
  }

  // 8) Umbral de autocompactación
  if (
    key === '8' ||
    key === 'umbral' ||
    key === 'threshold' ||
    key === 'autocompactthreshold' ||
    key === 'auto_compact_threshold'
  ) {
    const validation = validateAutoCompactThreshold(val);
    if (!validation.valid) {
      out(validation.error);
      return { settings: currentSettings, changed: false };
    }
    const prevVal = currentSettings.autoCompactThreshold ?? 70;
    if (validation.value === prevVal) {
      notifyUnchanged(
        'umbral de autocompactación',
        `${validation.value}%`,
        out,
      );
      return { settings: currentSettings, changed: false };
    }
    updated.autoCompactThreshold = validation.value;
    saveSettings(updated, customHomeDir);
    out(
      `Umbral de autocompactación cambiado de ${prevVal}% a ${updated.autoCompactThreshold}% (actualizado a: ${updated.autoCompactThreshold}%).`,
    );
    return { settings: updated, changed: true };
  }

  // 9) Visualización de pensamiento (thinkingDisplay)
  if (
    key === '9' ||
    key === 'thinkingdisplay' ||
    key === 'thinking_display' ||
    key === 'visualizacion'
  ) {
    const cleanVal = val.toLowerCase();
    const order: Array<'expandido' | 'contraido' | 'auto'> = [
      'expandido',
      'contraido',
      'auto',
    ];
    const curDisp = currentSettings.thinkingDisplay ?? 'expandido';
    const picked =
      !cleanVal && allowEmptyToggle
        ? order[(order.indexOf(curDisp) + 1) % order.length]!
        : cleanVal === 'expandido' ||
            cleanVal === 'contraido' ||
            cleanVal === 'auto'
          ? cleanVal
          : null;
    if (!picked) {
      out(
        'Valor inválido para thinkingDisplay. Valores permitidos: expandido, contraido, auto.',
      );
      return { settings: currentSettings, changed: false };
    }
    if (picked === curDisp) {
      notifyUnchanged('thinkingDisplay', picked, out);
      return { settings: currentSettings, changed: false };
    }
    updated.thinkingDisplay = picked;
    saveSettings(updated, customHomeDir);
    out(`thinkingDisplay cambiado de ${curDisp} a ${picked}.`);
    return { settings: updated, changed: true };
  }

  // 10) Modelo resumidor de bloques (thinkingSummaryModel)
  if (
    key === '10' ||
    key === 'thinkingsummarymodel' ||
    key === 'thinking_summary_model' ||
    key === 'resumidor'
  ) {
    if (!val) {
      out('Debes indicar un ID de modelo para thinkingSummaryModel.');
      return { settings: currentSettings, changed: false };
    }
    const curModel =
      currentSettings.thinkingSummaryModel ?? 'gemini-3.1-pro-preview';
    if (val === curModel) {
      notifyUnchanged('thinkingSummaryModel', curModel, out);
      return { settings: currentSettings, changed: false };
    }
    updated.thinkingSummaryModel = val;
    saveSettings(updated, customHomeDir);
    out(`thinkingSummaryModel cambiado de ${curModel} a ${val}.`);
    return { settings: updated, changed: true };
  }

  // 11) Límite de pasos de subagentes (subagentMaxSteps)
  if (
    key === '11' ||
    key === 'subagentmaxsteps' ||
    key === 'subagent_max_steps' ||
    key === 'pasos_subagentes'
  ) {
    const parsed = Number.parseInt(val, 10);
    if (Number.isNaN(parsed) || parsed < 0 || !/^\d+$/.test(val)) {
      out(
        'Valor inválido para subagentMaxSteps. Usa 0 (sin límite) o un entero positivo.',
      );
      return { settings: currentSettings, changed: false };
    }
    const curSteps = currentSettings.subagentMaxSteps ?? 0;
    if (parsed === curSteps) {
      notifyUnchanged('subagentMaxSteps', String(curSteps), out);
      return { settings: currentSettings, changed: false };
    }
    updated.subagentMaxSteps = parsed;
    saveSettings(updated, customHomeDir);
    out(
      `subagentMaxSteps cambiado de ${curSteps} a ${parsed} (${parsed === 0 ? 'sin límite' : `${parsed} pasos`}).`,
    );
    return { settings: updated, changed: true };
  }

  // 12) Recargo regional (regionalSurchargePct)
  if (
    key === '12' ||
    key === 'regionalsurchargepct' ||
    key === 'regional_surcharge_pct' ||
    key === 'recargo'
  ) {
    const cleanNum = val.replace(/%$/, '').trim();
    const parsed = Number.parseFloat(cleanNum);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
      out(
        'Valor inválido para regionalSurchargePct. Usa un número entre 0 y 100.',
      );
      return { settings: currentSettings, changed: false };
    }
    const curPct = currentSettings.regionalSurchargePct ?? 0;
    if (parsed === curPct) {
      notifyUnchanged('regionalSurchargePct', `${curPct}%`, out);
      return { settings: currentSettings, changed: false };
    }
    updated.regionalSurchargePct = parsed;
    saveSettings(updated, customHomeDir);
    out(`regionalSurchargePct cambiado de ${curPct}% a ${parsed}%.`);
    return { settings: updated, changed: true };
  }

  // 13) Editar precio de un modelo: /settings precio <modelo> <in>/<out>/<cache>
  if (
    key === '13' ||
    key === 'precio' ||
    key === 'precios' ||
    key === 'modelpricing' ||
    key === 'pricing'
  ) {
    const tokens = val.split(/\s+/).filter(Boolean);
    const modelId = tokens[0] ?? currentSettings.model;
    const rawNums = tokens.slice(1).join(' ').split(/[\/,\s]+/).filter(Boolean);
    if (rawNums.length < 3) {
      out(
        'Formato para editar precio: /settings precio <modelo> <entrada> <salida> <cache>',
      );
      return { settings: currentSettings, changed: false };
    }
    const inP = Number.parseFloat(rawNums[0]!);
    const outP = Number.parseFloat(rawNums[1]!);
    const cacheP = Number.parseFloat(rawNums[2]!);
    if (
      Number.isNaN(inP) ||
      Number.isNaN(outP) ||
      Number.isNaN(cacheP) ||
      inP <= 0 ||
      outP <= 0 ||
      cacheP < 0
    ) {
      out('Precios inválidos: entrada y salida deben ser mayores que 0.');
      return { settings: currentSettings, changed: false };
    }
    const nextSettings = applyModelPriceEdit(
      currentSettings,
      modelId,
      {
        inputPerMillion: inP,
        outputPerMillion: outP,
        cachePerMillion: cacheP,
      },
      customHomeDir,
    );
    out(
      `Precio de ${modelId} actualizado a ${inP} / ${outP} / ${cacheP} USD por 1M tok.`,
    );
    return { settings: nextSettings, changed: true };
  }

  // 14) Atajo de pensamiento (toggleThoughtsShortcut)
  if (
    key === '14' ||
    key === 'togglethoughtsshortcut' ||
    key === 'atajo' ||
    key === 'shortcut'
  ) {
    const cleanShort = val.toLowerCase();
    const curShort = (
      currentSettings.toggleThoughtsShortcut ?? 'ctrl+t'
    ).toLowerCase();
    const picked =
      !cleanShort && allowEmptyToggle
        ? curShort === 'ctrl+t'
          ? 'alt+t'
          : 'ctrl+t'
        : cleanShort === 'ctrl+t' || cleanShort === 'alt+t'
          ? cleanShort
          : null;
    if (!picked) {
      out('Atajo inválido. Valores permitidos: ctrl+t, alt+t.');
      return { settings: currentSettings, changed: false };
    }
    if (picked === curShort) {
      notifyUnchanged('toggleThoughtsShortcut', picked, out);
      return { settings: currentSettings, changed: false };
    }
    updated.toggleThoughtsShortcut = picked;
    saveSettings(updated, customHomeDir);
    out(`Atajo de pensamiento cambiado de ${curShort} a ${picked}.`);
    return { settings: updated, changed: true };
  }

  out(
    `Opción "${optionKeyOrNumber}" no válida en /settings. Opciones permitidas: modo, submodo, esfuerzo, thoughts, daa, preguntas, autocompactacion, umbral, thinkingDisplay, thinkingSummaryModel, subagentMaxSteps, regionalSurchargePct, precio, atajo.`,
  );
  return { settings: currentSettings, changed: false };
}

export async function runSettingsCommand(
  currentSettings: GlitchSettings,
  ask: QuestionFn,
  out: OutputFn = console.log,
  customHomeDir?: string,
): Promise<GlitchSettings> {
  const modeLabel = formatPermissionModeLabel(currentSettings.permissionMode);
  const subModeLabel = currentSettings.subMode === 'plan' ? 'Plan' : 'Agente';
  const thoughtsLabel = currentSettings.thoughts ? 'ON' : 'OFF';
  const daaWarningLabel = currentSettings.hideDaaWarning ? 'OFF' : 'ON';
  const askUserLabel =
    currentSettings.allowAgentQuestions === false ? 'OFF' : 'ON';
  const autoCompactLabel =
    currentSettings.autoCompact === false ? 'OFF' : 'ON';
  const thresholdVal = currentSettings.autoCompactThreshold ?? 70;

  out('=== Panel de Configuración y Comandos (/settings) ===');
  out('Comandos disponibles:');
  out('  /auth                     Configurar conexión (Vertex AI o API personalizada)');
  out('  /settings                 Abrir este panel de preferencias');
  out('  /model [id|num]           Seleccionar modelo disponible');
  out('  /effort [low|medium|high] Ver o cambiar el nivel de effort en vivo');
  out('  /help                     Mostrar ayuda y flags de línea de comandos');
  out('  /exit                     Salir de Glitch CLI');
  out('  Atajo de teclado          Shift+Tab (alterna Sub-Modo Plan <-> Agente en vivo)');
  out('-----------------------------------------------------');
  out('Preferencias actuales:');
  out(`  1) Modo de permisos               : ${modeLabel}`);
  out(`  2) Sub-Modo                       : ${subModeLabel}`);
  out(`  3) Esfuerzo por defecto           : ${currentSettings.effort.toUpperCase()}`);
  out(`  4) Thoughts                       : ${thoughtsLabel}`);
  out(`  5) Advertencia --DAA al inicio    : ${daaWarningLabel}`);
  out(`  6) Preguntas de la IA (ask_user)  : ${askUserLabel}`);
  out(`  7) Autocompactación               : ${autoCompactLabel}`);
  out(`  8) Umbral de autocompactación     : ${thresholdVal}%`);
  out('  Enter) Salir sin cambios');

  const choice = (await ask('Selecciona preferencia a cambiar [1-8]: ')).trim();
  if (!choice) {
    return currentSettings;
  }

  if (choice === '1') {
    out('Selecciona el Modo de permisos:');
    PERMISSION_OPTIONS.forEach((opt, idx) => {
      const active =
        opt.id === currentSettings.permissionMode ? ' (actual)' : '';
      out(`  ${idx + 1}) ${opt.label}${active}`);
    });
    const ans = (await ask('Modo [1-3]: ')).trim();
    return applySettingOptionValue(
      currentSettings,
      '1',
      ans,
      out,
      customHomeDir,
    ).settings;
  }

  if (choice === '2') {
    out('Selecciona el Sub-Modo:');
    SUBMODE_OPTIONS.forEach((opt, idx) => {
      const active = opt.id === currentSettings.subMode ? ' (actual)' : '';
      out(`  ${idx + 1}) ${opt.label}${active}`);
    });
    const ans = (await ask('Sub-Modo [1-2]: ')).trim();
    return applySettingOptionValue(
      currentSettings,
      '2',
      ans,
      out,
      customHomeDir,
    ).settings;
  }

  if (choice === '3') {
    out('Selecciona Esfuerzo por defecto (low / medium / high):');
    EFFORT_OPTIONS.forEach((ef, idx) => {
      const active = ef === currentSettings.effort ? ' (actual)' : '';
      out(`  ${idx + 1}) ${ef.toUpperCase()}${active}`);
    });
    const ans = (await ask('Esfuerzo [1-3 o low/medium/high]: ')).trim();
    return applySettingOptionValue(
      currentSettings,
      '3',
      ans,
      out,
      customHomeDir,
    ).settings;
  }

  if (choice === '4') {
    const ans = (
      await ask(`Thoughts [on/off, actual: ${thoughtsLabel}]: `)
    ).trim();
    return applySettingOptionValue(
      currentSettings,
      '4',
      ans,
      out,
      customHomeDir,
      true,
    ).settings;
  }

  if (choice === '5') {
    const ans = (
      await ask(
        `Advertencia --DAA al inicio [on/off, actual: ${daaWarningLabel}]: `,
      )
    ).trim();
    return applySettingOptionValue(
      currentSettings,
      '5',
      ans,
      out,
      customHomeDir,
      true,
    ).settings;
  }

  if (choice === '6') {
    const ans = (
      await ask(
        `Preguntas de la IA (ask_user) [on/off, actual: ${askUserLabel}]: `,
      )
    ).trim();
    return applySettingOptionValue(
      currentSettings,
      '6',
      ans,
      out,
      customHomeDir,
      true,
    ).settings;
  }

  if (choice === '7') {
    const ans = (
      await ask(
        `Autocompactación [on/off, actual: ${autoCompactLabel}]: `,
      )
    ).trim();
    return applySettingOptionValue(
      currentSettings,
      '7',
      ans,
      out,
      customHomeDir,
      true,
    ).settings;
  }

  if (choice === '8') {
    const ans = (
      await ask(
        `Umbral de autocompactación [10-95, actual: ${thresholdVal}]: `,
      )
    ).trim();
    return applySettingOptionValue(
      currentSettings,
      '8',
      ans,
      out,
      customHomeDir,
    ).settings;
  }

  return applySettingOptionValue(
    currentSettings,
    choice,
    '',
    out,
    customHomeDir,
  ).settings;
}
