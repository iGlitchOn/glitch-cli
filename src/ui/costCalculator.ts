import {
  DEFAULT_MODEL_PRICING,
  resolveModelPricingForDate,
  type ModelPricingStatusTag,
  type ModelPricingTable,
} from '../config/settings.js';
import type { ApiTokenUsage, RawApiUsageMetadata } from '../providers/types.js';

export const EMPTY_API_TOKEN_USAGE: ApiTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  toolUsePromptTokens: 0,
  totalPromptTokens: 0,
};

export function hasValidModelPricing(
  modelId: string,
  pricingTable: ModelPricingTable = DEFAULT_MODEL_PRICING,
  referenceDate?: Date | string,
): boolean {
  const rawPrice = pricingTable[modelId];
  if (!rawPrice) return false;
  const price = resolveModelPricingForDate(rawPrice, referenceDate);
  return Boolean(
    price && price.inputPerMillion > 0 && price.outputPerMillion > 0,
  );
}

export function formatChatTotalAmount(
  amount: number | null | undefined,
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return 'sin precio';
  }
  const dollar = String.fromCharCode(36);
  return dollar + Math.max(0, amount).toFixed(4);
}

export function formatUsdAmount(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return 'sin precio';
  }
  const dollar = String.fromCharCode(36);
  return dollar + Math.max(0, amount).toFixed(4);
}

export function computeLastRequestContextTokens(
  usage: ApiTokenUsage | undefined,
): number | null {
  if (!usage || !hasAnyApiTokenUsage(usage)) {
    return null;
  }
  const promptTok = Math.max(
    0,
    usage.totalPromptTokens ?? usage.inputTokens + usage.cachedTokens,
  );
  const outTok = Math.max(0, usage.outputTokens);
  const thoughtTok = Math.max(0, usage.reasoningTokens);
  const total = promptTok + outTok + thoughtTok;
  return total > 0 ? total : null;
}

export function mergeStreamChunkUsage(
  prev: ApiTokenUsage,
  chunkUsage: ApiTokenUsage | undefined,
): ApiTokenUsage {
  if (!chunkUsage) return prev;
  const prevMeta = prev.rawMetadata ?? {};
  const nextMeta = chunkUsage.rawMetadata ?? {};

  const mergedRaw: RawApiUsageMetadata = {
    promptTokenCount:
      nextMeta.promptTokenCount !== null &&
      nextMeta.promptTokenCount !== undefined
        ? nextMeta.promptTokenCount
        : (prevMeta.promptTokenCount ?? null),
    candidatesTokenCount:
      nextMeta.candidatesTokenCount !== null &&
      nextMeta.candidatesTokenCount !== undefined
        ? nextMeta.candidatesTokenCount
        : (prevMeta.candidatesTokenCount ?? null),
    cachedContentTokenCount:
      nextMeta.cachedContentTokenCount !== null &&
      nextMeta.cachedContentTokenCount !== undefined
        ? nextMeta.cachedContentTokenCount
        : (prevMeta.cachedContentTokenCount ?? null),
    thoughtsTokenCount:
      nextMeta.thoughtsTokenCount !== null &&
      nextMeta.thoughtsTokenCount !== undefined
        ? nextMeta.thoughtsTokenCount
        : (prevMeta.thoughtsTokenCount ?? null),
    toolUsePromptTokenCount:
      nextMeta.toolUsePromptTokenCount !== null &&
      nextMeta.toolUsePromptTokenCount !== undefined
        ? nextMeta.toolUsePromptTokenCount
        : (prevMeta.toolUsePromptTokenCount ?? null),
    totalTokenCount:
      nextMeta.totalTokenCount !== null &&
      nextMeta.totalTokenCount !== undefined
        ? nextMeta.totalTokenCount
        : (prevMeta.totalTokenCount ?? null),
  };

  return {
    inputTokens: Math.max(prev.inputTokens, chunkUsage.inputTokens),
    outputTokens: Math.max(prev.outputTokens, chunkUsage.outputTokens),
    cachedTokens: Math.max(prev.cachedTokens, chunkUsage.cachedTokens),
    reasoningTokens: Math.max(prev.reasoningTokens, chunkUsage.reasoningTokens),
    toolUsePromptTokens: Math.max(
      prev.toolUsePromptTokens ?? 0,
      chunkUsage.toolUsePromptTokens ?? 0,
    ),
    totalPromptTokens: Math.max(
      prev.totalPromptTokens ?? 0,
      chunkUsage.totalPromptTokens ?? 0,
    ),
    rawMetadata: mergedRaw,
  };
}

export function addApiTokenUsage(
  a: ApiTokenUsage,
  b: ApiTokenUsage | undefined,
): ApiTokenUsage {
  if (!b) return { ...a };
  return {
    inputTokens: a.inputTokens + Math.max(0, b.inputTokens),
    outputTokens: a.outputTokens + Math.max(0, b.outputTokens),
    cachedTokens: a.cachedTokens + Math.max(0, b.cachedTokens),
    reasoningTokens: a.reasoningTokens + Math.max(0, b.reasoningTokens),
    toolUsePromptTokens:
      (a.toolUsePromptTokens ?? 0) + Math.max(0, b.toolUsePromptTokens ?? 0),
    totalPromptTokens:
      (a.totalPromptTokens ?? 0) + Math.max(0, b.totalPromptTokens ?? 0),
  };
}

export function hasAnyApiTokenUsage(u: ApiTokenUsage | undefined): boolean {
  if (!u) return false;
  if (
    u.inputTokens > 0 ||
    u.outputTokens > 0 ||
    u.cachedTokens > 0 ||
    u.reasoningTokens > 0 ||
    (u.totalPromptTokens ?? 0) > 0
  ) {
    return true;
  }
  if (u.rawMetadata) {
    return Object.values(u.rawMetadata).some((v) => typeof v === 'number');
  }
  return false;
}

export interface AppliedPricingTierInfo {
  tierLabel: string;
  inputPerMillion: number;
  cachePerMillion: number;
  outputPerMillion: number;
  statusTag?: ModelPricingStatusTag;
}

export interface DetailedRequestCostResult {
  costUsd: number | null;
  appliedPricing: AppliedPricingTierInfo | null;
  warningMessage?: string;
}

export interface CostCalculationOptions {
  referenceDate?: Date | string;
  regionalSurchargePct?: number;
}

export interface CostRequestRecord {
  requestIndex: number;
  turnIndex: number;
  kind: 'agent' | 'tool_followup' | 'retry' | 'compaction' | 'thinking_summary';
  model: string;
  rawMetadata: RawApiUsageMetadata;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolUsePromptTokens: number;
  totalPromptTokens: number;
  appliedPricing: AppliedPricingTierInfo | null;
  costUsd: number | null;
}

export function calculateDetailedRequestCost(
  usage: ApiTokenUsage | undefined,
  modelId: string,
  pricingTable: ModelPricingTable = DEFAULT_MODEL_PRICING,
  countReasoningAsOutput = true,
  options?: CostCalculationOptions,
): DetailedRequestCostResult {
  const rawPrice = pricingTable[modelId];
  if (!rawPrice) {
    return {
      costUsd: null,
      appliedPricing: null,
      warningMessage: `El modelo "${modelId}" no tiene precio válido en la tabla de precios: sin precio.`,
    };
  }

  const price = resolveModelPricingForDate(rawPrice, options?.referenceDate);
  if (
    !price ||
    !(price.inputPerMillion > 0) ||
    !(price.outputPerMillion > 0)
  ) {
    return {
      costUsd: null,
      appliedPricing: null,
      warningMessage: `El modelo "${modelId}" no tiene precio válido en la tabla de precios: sin precio.`,
    };
  }

  if (!usage) {
    return {
      costUsd: null,
      appliedPricing: null,
      warningMessage: `Uso de tokens no reportado por la API para "${modelId}": sin precio.`,
    };
  }

  const inTokens = Math.max(0, usage.inputTokens);
  const cacheTokens = Math.max(0, usage.cachedTokens);
  const totalPrompt = usage.totalPromptTokens ?? inTokens + cacheTokens;
  const reasonTokens = countReasoningAsOutput
    ? Math.max(0, usage.reasoningTokens)
    : 0;
  const outTokens = Math.max(0, usage.outputTokens) + reasonTokens;

  const isOverTier = Boolean(
    price.tierThresholdTokens && totalPrompt > price.tierThresholdTokens,
  );

  const inputPerMillion = isOverTier
    ? (price.overThresholdInputPerMillion ?? price.inputPerMillion)
    : price.inputPerMillion;
  const cachePerMillion = isOverTier
    ? (price.overThresholdCachePerMillion ?? price.cachePerMillion)
    : price.cachePerMillion;
  const outputPerMillion = isOverTier
    ? (price.overThresholdOutputPerMillion ?? price.outputPerMillion)
    : price.outputPerMillion;

  const tierLabel = price.tierThresholdTokens
    ? isOverTier
      ? `>${Math.round(price.tierThresholdTokens / 1000)}k tok`
      : `<=${Math.round(price.tierThresholdTokens / 1000)}k tok`
    : 'estándar';

  const baseCostUsd =
    (inTokens * inputPerMillion +
      cacheTokens * cachePerMillion +
      outTokens * outputPerMillion) /
    1_000_000;

  const surchargePct = Math.max(0, options?.regionalSurchargePct ?? 0);
  const costUsd =
    surchargePct > 0 ? baseCostUsd * (1 + surchargePct / 100) : baseCostUsd;

  return {
    costUsd,
    appliedPricing: {
      tierLabel,
      inputPerMillion,
      cachePerMillion,
      outputPerMillion,
      statusTag: price.statusTag,
    },
  };
}

export function calculateApiUsageCostUsd(
  usage: ApiTokenUsage,
  modelId: string,
  pricingTable: ModelPricingTable = DEFAULT_MODEL_PRICING,
  countReasoningAsOutput = true,
  options?: CostCalculationOptions,
): number | null {
  return calculateDetailedRequestCost(
    usage,
    modelId,
    pricingTable,
    countReasoningAsOutput,
    options,
  ).costUsd;
}

export function buildCostRequestRecord(params: {
  requestIndex: number;
  turnIndex: number;
  kind: CostRequestRecord['kind'];
  model: string;
  usage: ApiTokenUsage | undefined;
  pricingTable?: ModelPricingTable;
  referenceDate?: Date | string;
  regionalSurchargePct?: number;
}): CostRequestRecord {
  const u = params.usage;
  const rawMetadata: RawApiUsageMetadata = u?.rawMetadata ?? {
    promptTokenCount: u ? u.inputTokens + u.cachedTokens : null,
    candidatesTokenCount: u ? u.outputTokens : null,
    cachedContentTokenCount: u ? u.cachedTokens : null,
    thoughtsTokenCount: u ? u.reasoningTokens : null,
    toolUsePromptTokenCount: u?.toolUsePromptTokens ?? null,
    totalTokenCount: null,
  };

  const hasReported = hasAnyApiTokenUsage(u);
  const detailed = hasReported
    ? calculateDetailedRequestCost(
        u,
        params.model,
        params.pricingTable ?? DEFAULT_MODEL_PRICING,
        true,
        {
          referenceDate: params.referenceDate,
          regionalSurchargePct: params.regionalSurchargePct,
        },
      )
    : { costUsd: null, appliedPricing: null };

  const inTok = u ? Math.max(0, u.inputTokens) : 0;
  const cacheTok = u ? Math.max(0, u.cachedTokens) : 0;
  const outTok = u ? Math.max(0, u.outputTokens) : 0;
  const reasonTok = u ? Math.max(0, u.reasoningTokens) : 0;
  const toolPromptTok = u ? Math.max(0, u.toolUsePromptTokens ?? 0) : 0;
  const totalPromptTok = u
    ? Math.max(0, u.totalPromptTokens ?? inTok + cacheTok)
    : 0;

  return {
    requestIndex: params.requestIndex,
    turnIndex: params.turnIndex,
    kind: params.kind,
    model: params.model,
    rawMetadata,
    inputTokens: inTok,
    cachedTokens: cacheTok,
    outputTokens: outTok,
    reasoningTokens: reasonTok,
    toolUsePromptTokens: toolPromptTok,
    totalPromptTokens: totalPromptTok,
    appliedPricing: detailed.appliedPricing,
    costUsd: detailed.costUsd,
  };
}

export interface TurnCostBreakdown {
  turnIndex: number;
  requestCount: number;
  unknownPriceCount: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
}

export interface ChatCostSummary {
  totalChatCostUsd: number | null;
  lastTurnCostUsd: number | null;
  unknownPriceRequestCount: number;
  knownPriceRequestCount: number;
  turnBreakdowns: TurnCostBreakdown[];
}

export function computeChatCostSummary(
  records: readonly CostRequestRecord[],
  currentModelId: string,
  pricingTable: ModelPricingTable = DEFAULT_MODEL_PRICING,
  inFlightUsage?: ApiTokenUsage,
  inFlightModelId?: string,
  options?: CostCalculationOptions,
): ChatCostSummary {
  const activeModel = inFlightModelId ?? currentModelId;
  const activeModelHasValidPrice = hasValidModelPricing(
    activeModel,
    pricingTable,
    options?.referenceDate,
  );

  const turnMap = new Map<number, TurnCostBreakdown>();
  let committedSum = 0;
  let knownPriceRequestCount = 0;
  let unknownPriceRequestCount = 0;

  for (const rec of records) {
    const existing = turnMap.get(rec.turnIndex) ?? {
      turnIndex: rec.turnIndex,
      requestCount: 0,
      unknownPriceCount: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    };
    existing.requestCount += 1;
    existing.inputTokens += rec.inputTokens;
    existing.cachedTokens += rec.cachedTokens;
    existing.outputTokens += rec.outputTokens;
    existing.reasoningTokens += rec.reasoningTokens;

    if (rec.costUsd === null) {
      existing.unknownPriceCount += 1;
      unknownPriceRequestCount += 1;
      if (existing.costUsd === 0 && existing.requestCount === existing.unknownPriceCount) {
        existing.costUsd = null;
      }
    } else {
      knownPriceRequestCount += 1;
      existing.costUsd = (existing.costUsd ?? 0) + rec.costUsd;
      committedSum += rec.costUsd;
    }
    turnMap.set(rec.turnIndex, existing);
  }

  let inFlightCost = 0;
  let inFlightKnown = false;
  if (inFlightUsage && hasAnyApiTokenUsage(inFlightUsage)) {
    const liveCalc = calculateDetailedRequestCost(
      inFlightUsage,
      activeModel,
      pricingTable,
      true,
      options,
    );
    if (liveCalc.costUsd === null) {
      unknownPriceRequestCount += 1;
    } else {
      inFlightCost = liveCalc.costUsd;
      inFlightKnown = true;
    }
  }

  const turnBreakdowns = Array.from(turnMap.values()).sort(
    (a, b) => a.turnIndex - b.turnIndex,
  );

  const hasAnyKnown = knownPriceRequestCount > 0 || inFlightKnown;
  const totalChatCostUsd = hasAnyKnown
    ? committedSum + inFlightCost
    : unknownPriceRequestCount > 0 || !activeModelHasValidPrice
      ? null
      : 0;

  const lastTurnEntry = turnBreakdowns.at(-1);
  const lastTurnCostUsd = lastTurnEntry
    ? lastTurnEntry.costUsd === null
      ? inFlightKnown
        ? inFlightCost
        : null
      : lastTurnEntry.costUsd + inFlightCost
    : inFlightKnown
      ? inFlightCost
      : records.length === 0
        ? activeModelHasValidPrice
          ? 0
          : null
        : null;

  return {
    totalChatCostUsd,
    lastTurnCostUsd,
    unknownPriceRequestCount,
    knownPriceRequestCount,
    turnBreakdowns,
  };
}

export function formatRawUsageField(val: number | null | undefined): string {
  if (typeof val === 'number' && !Number.isNaN(val)) {
    return val.toLocaleString('en-US');
  }
  return 'no reportado';
}

export function formatCostAuditReport(
  records: readonly CostRequestRecord[],
  turnCostUsd: number | null,
  sessionCostUsd: number | null,
  currentModelId: string,
  pricingTable: ModelPricingTable = DEFAULT_MODEL_PRICING,
): string[] {
  const lines: string[] = [];
  const rawActivePrice = pricingTable[currentModelId];
  const activePrice = rawActivePrice
    ? resolveModelPricingForDate(rawActivePrice)
    : undefined;
  const dollar = String.fromCharCode(36);
  const summary = computeChatCostSummary(records, currentModelId, pricingTable);
  const effectiveTotalChat =
    sessionCostUsd !== undefined && sessionCostUsd !== null
      ? sessionCostUsd
      : summary.totalChatCostUsd;
  const effectiveLastTurn =
    turnCostUsd !== undefined ? turnCostUsd : summary.lastTurnCostUsd;

  if (
    !activePrice ||
    !(activePrice.inputPerMillion > 0) ||
    !(activePrice.outputPerMillion > 0)
  ) {
    lines.push(
      `Modelo activo (${currentModelId}): sin precio (no figura en la tabla de precios o su precio es 0).`,
    );
  } else {
    const tierNote = activePrice.tierThresholdTokens
      ? ` | >${Math.round(activePrice.tierThresholdTokens / 1000)}k: entrada=${dollar}${activePrice.overThresholdInputPerMillion?.toFixed(2)}/1M, caché=${dollar}${activePrice.overThresholdCachePerMillion?.toFixed(4)}/1M, salida+razonamiento=${dollar}${activePrice.overThresholdOutputPerMillion?.toFixed(2)}/1M`
      : '';
    const tagNote = activePrice.statusTag ? ` [${activePrice.statusTag}]` : '';
    lines.push(
      `Tarifa oficial (${currentModelId}${tagNote}, USD por 1M tok): entrada=${dollar}${activePrice.inputPerMillion.toFixed(2)}/1M | caché=${dollar}${activePrice.cachePerMillion.toFixed(4)}/1M | salida+razonamiento=${dollar}${activePrice.outputPerMillion.toFixed(2)}/1M${tierNote}`,
    );
  }

  if (records.length === 0) {
    lines.push('  (Aún no se han registrado peticiones a la API en esta sesión)');
  } else {
    lines.push('  Desglose por turno:');
    for (const tb of summary.turnBreakdowns) {
      lines.push(
        `    - Turno #${tb.turnIndex} (${tb.requestCount} pet.): entrada=${tb.inputTokens.toLocaleString('en-US')} | caché=${tb.cachedTokens.toLocaleString('en-US')} | salida=${tb.outputTokens.toLocaleString('en-US')} | razonamiento=${tb.reasoningTokens.toLocaleString('en-US')} | subtotal=${formatUsdAmount(tb.costUsd)}`,
      );
    }
    lines.push('  Desglose por petición:');
    for (const rec of records) {
      const promptStr = formatRawUsageField(rec.rawMetadata.promptTokenCount);
      const cacheStr = formatRawUsageField(rec.rawMetadata.cachedContentTokenCount);
      const outStr = formatRawUsageField(rec.rawMetadata.candidatesTokenCount);
      const thoughtStr = formatRawUsageField(rec.rawMetadata.thoughtsTokenCount);
      const toolPromptStr = formatRawUsageField(rec.rawMetadata.toolUsePromptTokenCount);
      const priceStr = rec.appliedPricing
        ? `${dollar}${rec.appliedPricing.inputPerMillion}/${dollar}${rec.appliedPricing.cachePerMillion}/${dollar}${rec.appliedPricing.outputPerMillion} (${rec.appliedPricing.tierLabel})`
        : 'sin precio';
      const costStr = formatUsdAmount(rec.costUsd);
      lines.push(
        `    #${rec.requestIndex} [T${rec.turnIndex}·${rec.kind}] ${rec.model} | entrada=${rec.inputTokens.toLocaleString('en-US')} (prompt=${promptStr}, toolPrompt=${toolPromptStr}) | caché=${cacheStr} | salida=${outStr} | razonamiento=${thoughtStr} | tarifa=${priceStr} | costo=${costStr}`,
      );
    }
  }

  const unknownSuffix =
    summary.unknownPriceRequestCount > 0
      ? ` (${summary.unknownPriceRequestCount} sin precio)`
      : '';
  lines.push(
    `Total último turno: ${formatUsdAmount(effectiveLastTurn)}  |  Total del chat (${records.length} peticiones): ${formatUsdAmount(effectiveTotalChat)}${unknownSuffix} (Total: ${formatChatTotalAmount(effectiveTotalChat)})`,
  );
  lines.push(
    'Nota: Costos calculados a precio de lista oficial de Vertex AI (USD por 1.000.000 de tokens). Si tu cuenta tiene créditos Free Trial o descuentos de Google Cloud, el cobro real en factura puede variar.',
  );
  return lines;
}
