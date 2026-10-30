import type { Key } from 'ink';
import { getModelDefinition } from '../config/models.js';
import {
  applyModelPriceEdit,
  formatEffortValueEs,
  isAuthConfigured,
  maskApiKey,
  notifyUnchanged,
  validateAutoCompactThreshold,
  type CustomEndpointFormat,
  type EffortLevel,
  type GlitchSettings,
  type PermissionMode,
  type ThinkingDisplayMode,
} from '../config/settings.js';
import { toggleSubMode } from '../permissions/permissions.js';
import type { DialogKeyHandlerContext } from './tuiDialogKeys.js';

export function handleConfigDialogKeys(
  input: string,
  key: Key,
  ctx: DialogKeyHandlerContext,
): boolean {
  if (ctx.activeDialog === 'auth') {
    if (key.escape && isAuthConfigured(ctx.settings)) {
      ctx.setActiveDialog('none');
      return true;
    }
    if (ctx.authStep === 'provider') {
      if (key.upArrow || key.downArrow) {
        ctx.setAuthChoiceIdx((prev) => (prev === 0 ? 1 : 0));
        return true;
      }
      if (key.return) {
        if (ctx.authChoiceIdx === 0) {
          ctx.setAuthBuffer(ctx.tempProject);
          ctx.setAuthStep('vertex_project');
        } else {
          ctx.setAuthBuffer(ctx.tempUrl);
          ctx.setAuthStep('custom_url');
        }
      }
      return true;
    }
    if (ctx.authStep === 'custom_format') {
      if (key.upArrow || key.downArrow) {
        ctx.setAuthChoiceIdx((prev) => (prev === 0 ? 1 : 0));
        return true;
      }
      if (key.return) {
        const format: CustomEndpointFormat =
          ctx.authChoiceIdx === 1 ? 'responses' : 'chat_completions';
        const updated: GlitchSettings = {
          ...ctx.settings,
          provider: 'custom',
          custom: { baseUrl: ctx.tempUrl, apiKey: ctx.tempKey, format },
        };
        ctx.syncSettings(updated);
        ctx.setActiveDialog('none');
        ctx.addSystemMessage(
          `API personalizada conectada (${ctx.tempUrl}, formato: ${format}, key: ${maskApiKey(ctx.tempKey)}).`,
        );
      }
      return true;
    }
    if (key.return) {
      const val = ctx.authBuffer.trim();
      if (ctx.authStep === 'vertex_project') {
        if (!val) return true;
        ctx.setTempProject(val);
        ctx.setAuthBuffer(
          ctx.settings.vertex?.location ||
            process.env['GOOGLE_CLOUD_LOCATION'] ||
            'us-central1',
        );
        ctx.setAuthStep('vertex_location');
        return true;
      }
      if (ctx.authStep === 'vertex_location') {
        const loc = val || 'us-central1';
        const updated: GlitchSettings = {
          ...ctx.settings,
          provider: 'vertex',
          vertex: { project: ctx.tempProject, location: loc },
        };
        process.env['GOOGLE_CLOUD_PROJECT'] = ctx.tempProject;
        process.env['GOOGLE_CLOUD_LOCATION'] = loc;
        ctx.syncSettings(updated);
        ctx.setActiveDialog('none');
        ctx.addSystemMessage(
          `Conectado a Vertex AI (proyecto: ${ctx.tempProject}, región: ${loc}) usando ADC.`,
        );
        void ctx.refreshModels(updated);
        return true;
      }
      if (ctx.authStep === 'custom_url') {
        if (!val) return true;
        ctx.setTempUrl(val);
        ctx.setAuthBuffer('');
        ctx.setAuthStep('custom_key');
        return true;
      }
      if (ctx.authStep === 'custom_key') {
        const finalKey = val || ctx.settings.custom?.apiKey || '';
        if (!finalKey) return true;
        ctx.setTempKey(finalKey);
        ctx.setAuthChoiceIdx(0);
        ctx.setAuthStep('custom_format');
      }
      return true;
    }
    if (key.backspace || key.delete) {
      ctx.setAuthBuffer((prev) => prev.slice(0, -1));
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      ctx.setAuthBuffer((prev) => prev + input);
    }
    return true;
  }

  if (ctx.activeDialog === 'model') {
    if (ctx.pendingModelForEffort) {
      const efforts = ctx.pendingModelForEffort.supportedEfforts;
      if (key.escape) {
        ctx.setPendingModelForEffort(null);
        return true;
      }
      if (key.leftArrow || key.upArrow) {
        ctx.setModelEffortIdx((prev) => (prev > 0 ? prev - 1 : efforts.length - 1));
        return true;
      }
      if (key.rightArrow || key.downArrow) {
        ctx.setModelEffortIdx((prev) => (prev < efforts.length - 1 ? prev + 1 : 0));
        return true;
      }
      if (key.return) {
        const chosenEffort =
          efforts[ctx.modelEffortIdx] ??
          ctx.pendingModelForEffort.defaultEffort ??
          efforts[0]!;
        if (
          ctx.pendingModelForEffort.id === ctx.settings.model &&
          chosenEffort === ctx.settings.effort
        ) {
          notifyUnchanged('model', ctx.pendingModelForEffort.name, ctx.addSystemMessage);
          ctx.setPendingModelForEffort(null);
          ctx.setActiveDialog('none');
          return true;
        }
        const prevDef = getModelDefinition(ctx.settings.model, ctx.settings.provider ?? 'vertex');
        const updated: GlitchSettings = {
          ...ctx.settings,
          model: ctx.pendingModelForEffort.id,
          effort: chosenEffort,
        };
        ctx.syncSettings(updated);
        ctx.addSystemMessage(
          `Modelo cambiado de ${prevDef.name} a ${ctx.pendingModelForEffort.name} (${ctx.pendingModelForEffort.id}) | Esfuerzo: ${formatEffortValueEs(chosenEffort)} (${chosenEffort.toUpperCase()})`,
        );
        ctx.setPendingModelForEffort(null);
        ctx.setActiveDialog('none');
      }
      return true;
    }

    const currentPage = ctx.modelPages[ctx.modelPageIdx] ?? ctx.modelPages[0];
    const pageModels = currentPage?.models ?? [];

    if (key.escape) {
      ctx.setActiveDialog('none');
      return true;
    }
    if (key.leftArrow && ctx.modelPages.length > 0) {
      ctx.setModelPageIdx((prev) => (prev > 0 ? prev - 1 : ctx.modelPages.length - 1));
      ctx.setDialogCursor(0);
      return true;
    }
    if (key.rightArrow && ctx.modelPages.length > 0) {
      ctx.setModelPageIdx((prev) => (prev < ctx.modelPages.length - 1 ? prev + 1 : 0));
      ctx.setDialogCursor(0);
      return true;
    }
    if (key.upArrow && pageModels.length > 0) {
      ctx.setDialogCursor((prev) => (prev > 0 ? prev - 1 : pageModels.length - 1));
      return true;
    }
    if (key.downArrow && pageModels.length > 0) {
      ctx.setDialogCursor((prev) => (prev < pageModels.length - 1 ? prev + 1 : 0));
      return true;
    }
    if (key.return) {
      const picked = pageModels[ctx.dialogCursor];
      if (picked) {
        if (picked.supportedEfforts.length > 1) {
          const defaultEffort = picked.supportedEfforts.includes(ctx.settings.effort)
            ? ctx.settings.effort
            : (picked.defaultEffort ?? picked.supportedEfforts[0]!);
          const effIdx = Math.max(0, picked.supportedEfforts.indexOf(defaultEffort));
          ctx.setModelEffortIdx(effIdx);
          ctx.setPendingModelForEffort(picked);
          return true;
        }
        if (picked.id === ctx.settings.model) {
          notifyUnchanged('model', picked.name, ctx.addSystemMessage);
          ctx.setActiveDialog('none');
          return true;
        }
        if (ctx.session.isRequestActive) {
          ctx.addSystemMessage('No puedes cambiar de modelo mientras hay una petición activa.');
          ctx.setActiveDialog('none');
          return true;
        }
        const prevDef = getModelDefinition(ctx.settings.model, ctx.settings.provider ?? 'vertex');
        const nextEffort =
          picked.supportedEfforts.length === 1 ? picked.supportedEfforts[0]! : ctx.settings.effort;
        const updated: GlitchSettings = { ...ctx.settings, model: picked.id, effort: nextEffort };
        ctx.syncSettings(updated);
        ctx.addSystemMessage(
          `Modelo cambiado de ${prevDef.name} a ${picked.name} (${picked.id}) | ${picked.supportedEfforts.length > 0 ? `Esfuerzo: ${formatEffortValueEs(updated.effort)} (${updated.effort.toUpperCase()})` : 'Esfuerzo: N/A'}`,
        );
      }
      ctx.setActiveDialog('none');
    }
    return true;
  }

  if (ctx.activeDialog === 'effort') {
    const cur = ctx.session.settings;
    const def = getModelDefinition(cur.model, cur.provider ?? 'vertex');
    const efforts = def.supportedEfforts;

    if (key.escape) {
      ctx.setActiveDialog('none');
      return true;
    }
    if ((key.upArrow || key.leftArrow) && efforts.length > 0) {
      ctx.setDialogCursor((prev) => (prev > 0 ? prev - 1 : efforts.length - 1));
      return true;
    }
    if ((key.downArrow || key.rightArrow) && efforts.length > 0) {
      ctx.setDialogCursor((prev) => (prev < efforts.length - 1 ? prev + 1 : 0));
      return true;
    }
    if (key.return) {
      const chosenEffort = efforts[ctx.dialogCursor] ?? efforts[0];
      if (chosenEffort) {
        if (chosenEffort === cur.effort) {
          notifyUnchanged('effort', formatEffortValueEs(chosenEffort), ctx.addSystemMessage);
          ctx.setActiveDialog('none');
          return true;
        }
        const prevEs = formatEffortValueEs(cur.effort);
        const nextEs = formatEffortValueEs(chosenEffort);
        const updated: GlitchSettings = { ...cur, effort: chosenEffort };
        ctx.syncSettings(updated);
        ctx.addSystemMessage(
          `Esfuerzo cambiado de ${prevEs} a ${nextEs} (${chosenEffort.toUpperCase()}) para ${def.name} (${cur.model}).`,
        );
      }
      ctx.setActiveDialog('none');
    }
    return true;
  }

  if (ctx.activeDialog === 'settings') {
    const maxSettingsIdx = 13;
    if (ctx.editingThresholdMode) {
      if (key.escape) {
        ctx.setEditingThresholdMode(false);
        ctx.setThresholdError('');
        return true;
      }
      if (key.return) {
        const cur = ctx.session.settings;
        const rawVal = ctx.thresholdBuffer.trim();
        if (ctx.dialogCursor === 7) {
          const validation = validateAutoCompactThreshold(rawVal);
          if (!validation.valid) {
            ctx.setThresholdError(validation.error);
            return true;
          }
          ctx.syncSettings({ ...cur, autoCompactThreshold: validation.value });
        } else if (ctx.dialogCursor === 9) {
          if (!rawVal) {
            ctx.setThresholdError('Ingresa un ID de modelo válido.');
            return true;
          }
          ctx.syncSettings({ ...cur, thinkingSummaryModel: rawVal });
        } else if (ctx.dialogCursor === 10) {
          const num = Number.parseInt(rawVal, 10);
          if (Number.isNaN(num) || num < 0 || !/^\d+$/.test(rawVal)) {
            ctx.setThresholdError('Usa 0 (sin límite) o un entero positivo.');
            return true;
          }
          ctx.syncSettings({ ...cur, subagentMaxSteps: num });
        } else if (ctx.dialogCursor === 11) {
          const cleanPct = rawVal.replace(/%$/, '').trim();
          const pct = Number.parseFloat(cleanPct);
          if (Number.isNaN(pct) || pct < 0 || pct > 100) {
            ctx.setThresholdError('Usa un porcentaje entre 0 y 100.');
            return true;
          }
          ctx.syncSettings({ ...cur, regionalSurchargePct: pct });
        } else if (ctx.dialogCursor === 12) {
          const parts = rawVal.split(/[\/,\s]+/).filter(Boolean);
          if (parts.length < 4) {
            ctx.setThresholdError('Formato: <modelo> <in> <out> <cache>');
            return true;
          }
          const modelId = parts[0]!;
          const inP = Number.parseFloat(parts[1]!);
          const outP = Number.parseFloat(parts[2]!);
          const cacheP = Number.parseFloat(parts[3]!);
          if (Number.isNaN(inP) || Number.isNaN(outP) || Number.isNaN(cacheP) || inP <= 0 || outP <= 0 || cacheP < 0) {
            ctx.setThresholdError('Precios inválidos.');
            return true;
          }
          const nextSettings = applyModelPriceEdit(cur, modelId, {
            inputPerMillion: inP,
            outputPerMillion: outP,
            cachePerMillion: cacheP,
          });
          ctx.syncSettings(nextSettings);
        }
        ctx.setEditingThresholdMode(false);
        ctx.setThresholdError('');
        return true;
      }
      if (key.backspace || key.delete) {
        ctx.setThresholdBuffer((prev) => prev.slice(0, -1));
        ctx.setThresholdError('');
        return true;
      }
      if (input && !key.ctrl && !key.meta) {
        ctx.setThresholdBuffer((prev) => prev + input);
        ctx.setThresholdError('');
      }
      return true;
    }

    if (key.escape) {
      ctx.setThresholdError('');
      ctx.setActiveDialog('none');
      return true;
    }
    if (key.upArrow) {
      ctx.setThresholdError('');
      ctx.setDialogCursor((prev) => (prev > 0 ? prev - 1 : maxSettingsIdx));
      return true;
    }
    if (key.downArrow) {
      ctx.setThresholdError('');
      ctx.setDialogCursor((prev) => (prev < maxSettingsIdx ? prev + 1 : 0));
      return true;
    }
    if (key.return || key.leftArrow || key.rightArrow) {
      const cur = ctx.session.settings;
      if (ctx.dialogCursor === 0) {
        const order: PermissionMode[] = ['always_allow', 'ask_insecure', 'always_ask'];
        const nextMode = order[(order.indexOf(cur.permissionMode) + 1) % order.length]!;
        ctx.syncSettings({ ...cur, permissionMode: nextMode });
      } else if (ctx.dialogCursor === 1) {
        ctx.syncSettings({ ...cur, subMode: toggleSubMode(cur.subMode) });
      } else if (ctx.dialogCursor === 2) {
        const def = getModelDefinition(cur.model, cur.provider ?? 'vertex');
        const order: EffortLevel[] =
          def.supportedEfforts.length > 0 ? [...def.supportedEfforts] : ['low', 'medium', 'high'];
        const curIdx = Math.max(0, order.indexOf(cur.effort));
        const nextEffort = order[(curIdx + 1) % order.length]!;
        ctx.syncSettings({ ...cur, effort: nextEffort });
      } else if (ctx.dialogCursor === 3) {
        ctx.syncSettings({ ...cur, thoughts: !cur.thoughts });
      } else if (ctx.dialogCursor === 4) {
        ctx.syncSettings({ ...cur, hideDaaWarning: !cur.hideDaaWarning });
      } else if (ctx.dialogCursor === 5) {
        ctx.syncSettings({ ...cur, allowAgentQuestions: !(cur.allowAgentQuestions ?? true) });
      } else if (ctx.dialogCursor === 6) {
        ctx.syncSettings({ ...cur, autoCompact: !(cur.autoCompact ?? true) });
      } else if (ctx.dialogCursor === 7) {
        const curVal = cur.autoCompactThreshold ?? 70;
        if (key.return) {
          ctx.setThresholdBuffer(String(curVal));
          ctx.setThresholdError('');
          ctx.setEditingThresholdMode(true);
        } else {
          const delta = key.leftArrow ? -5 : 5;
          ctx.syncSettings({ ...cur, autoCompactThreshold: Math.max(10, Math.min(95, curVal + delta)) });
        }
      } else if (ctx.dialogCursor === 8) {
        const order: ThinkingDisplayMode[] = ['expandido', 'contraido', 'auto'];
        const curDisp = cur.thinkingDisplay ?? 'expandido';
        const nextDisp = order[(order.indexOf(curDisp) + 1) % order.length]!;
        ctx.syncSettings({ ...cur, thinkingDisplay: nextDisp });
      } else if (ctx.dialogCursor === 9) {
        ctx.setThresholdBuffer(cur.thinkingSummaryModel ?? 'gemini-3.1-pro-preview');
        ctx.setThresholdError('');
        ctx.setEditingThresholdMode(true);
      } else if (ctx.dialogCursor === 10) {
        ctx.setThresholdBuffer(String(cur.subagentMaxSteps ?? 0));
        ctx.setThresholdError('');
        ctx.setEditingThresholdMode(true);
      } else if (ctx.dialogCursor === 11) {
        ctx.setThresholdBuffer(String(cur.regionalSurchargePct ?? 0));
        ctx.setThresholdError('');
        ctx.setEditingThresholdMode(true);
      } else if (ctx.dialogCursor === 12) {
        const p = cur.modelPricing?.[cur.model];
        ctx.setThresholdBuffer(
          p
            ? `${cur.model} ${p.inputPerMillion} ${p.outputPerMillion} ${p.cachePerMillion}`
            : `${cur.model} 2 10 0.1`,
        );
        ctx.setThresholdError('');
        ctx.setEditingThresholdMode(true);
      } else if (ctx.dialogCursor === 13) {
        const curShort = (cur.toggleThoughtsShortcut ?? 'ctrl+t').toLowerCase();
        ctx.syncSettings({ ...cur, toggleThoughtsShortcut: curShort === 'ctrl+t' ? 'alt+t' : 'ctrl+t' });
      }
    }
    return true;
  }

  return false;
}
