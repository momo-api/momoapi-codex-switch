import { isMediaGenerationModelId } from "../codex/catalog/parsing";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";
import { syncModelsToCodex } from "../codex/sync";
import { resolveEnvValue, saveConfigPreservingClaudeCode } from "../config";
import { routedSlug } from "../providers/slug-codec";
import type { OcxComboConfig, OcxConfig, OcxMomoModelAutoSyncConfig } from "../types";

export const MOMO_RESPONSES_PROVIDER_ID = "momo-responses";
export const MOMO_CLAUDE_PROVIDER_ID = "momo-claude";
export const MOMO_GEMINI_PROVIDER_ID = "momo-gemini";
export const MOMO_DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 60;

const MOMO_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type MomoModelKind = "text" | "image" | "unknown";

export interface MomoModelClassification {
  kind: MomoModelKind;
  provider?: string;
  reason: string;
}

export interface MomoAutoSyncChange {
  model: string;
  provider?: string;
  comboId?: string;
  kind: MomoModelKind;
  reason?: string;
}

export interface MomoAutoSyncResult {
  enabled: boolean;
  changed: boolean;
  fetched: number;
  addedProviderModels: MomoAutoSyncChange[];
  removedProviderModels: MomoAutoSyncChange[];
  addedCombos: MomoAutoSyncChange[];
  removedCombos: MomoAutoSyncChange[];
  skipped: MomoAutoSyncChange[];
  imagesProviderChanged: boolean;
}

export interface MomoModelsListClient {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface MomoModelAutoSyncRunDeps {
  fetch?: MomoModelsListClient["fetch"];
  saveConfig?: (config: OcxConfig) => void;
  refreshCatalog?: (config: OcxConfig) => Promise<void>;
  log?: Pick<Console, "log" | "warn">;
}

export interface MomoModelAutoSyncSchedulerDeps extends MomoModelAutoSyncRunDeps {
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface MomoModelAutoSyncHandle {
  stop(): void;
}

function effectiveAutoSyncConfig(config: Pick<OcxConfig, "momoModelAutoSync">): Required<OcxMomoModelAutoSyncConfig> {
  const raw = config.momoModelAutoSync ?? {};
  const interval = typeof raw.intervalMinutes === "number" && Number.isFinite(raw.intervalMinutes)
    ? Math.floor(raw.intervalMinutes)
    : MOMO_DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
  return {
    enabled: raw.enabled === true,
    catalogMode: raw.catalogMode ?? "momo",
    intervalMinutes: Math.min(24 * 60, Math.max(1, interval)),
    autoCreateCombos: raw.autoCreateCombos !== false,
    autoRefreshCatalog: raw.autoRefreshCatalog !== false,
    includeImageModels: raw.includeImageModels !== false,
    exposeUnknownModels: raw.exposeUnknownModels === true,
    notifyOnChanges: raw.notifyOnChanges !== false,
    managedModelIds: [...new Set(raw.managedModelIds ?? [])],
  };
}

export function momoAutoComboId(modelId: string): string {
  const compact = modelId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 53);
  return `momo-model-${compact || "model"}`;
}

function displayNameForMomoModel(modelId: string): string {
  return modelId
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map(part => {
      const lower = part.toLowerCase();
      if (["gpt", "api", "ox", "ai"].includes(lower)) return lower.toUpperCase();
      if (/^v\d+$/i.test(part)) return part.toUpperCase();
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function providerExists(config: Pick<OcxConfig, "providers">, provider: string): boolean {
  return Object.hasOwn(config.providers, provider);
}

export function classifyMomoModelId(modelId: string, config: Pick<OcxConfig, "providers">): MomoModelClassification {
  const id = modelId.trim();
  if (!MOMO_MODEL_ID_PATTERN.test(id)) return { kind: "unknown", reason: "unsupported-public-model-id" };
  if (isMediaGenerationModelId(id)) {
    return providerExists(config, MOMO_RESPONSES_PROVIDER_ID)
      ? { kind: "image", provider: MOMO_RESPONSES_PROVIDER_ID, reason: "media-generation" }
      : { kind: "unknown", reason: "momo-responses-provider-missing" };
  }
  if (/^claude[-_.]/i.test(id)) {
    return providerExists(config, MOMO_CLAUDE_PROVIDER_ID)
      ? { kind: "text", provider: MOMO_CLAUDE_PROVIDER_ID, reason: "claude" }
      : { kind: "unknown", reason: "momo-claude-provider-missing" };
  }
  if (/^gemini[-_.]/i.test(id)) {
    return providerExists(config, MOMO_GEMINI_PROVIDER_ID)
      ? { kind: "text", provider: MOMO_GEMINI_PROVIDER_ID, reason: "gemini" }
      : { kind: "unknown", reason: "momo-gemini-provider-missing" };
  }
  if (providerExists(config, MOMO_RESPONSES_PROVIDER_ID)) {
    return { kind: "text", provider: MOMO_RESPONSES_PROVIDER_ID, reason: "openai-compatible" };
  }
  return { kind: "unknown", reason: "momo-responses-provider-missing" };
}

function addUnique(list: string[] | undefined, value: string): { list: string[]; changed: boolean } {
  const out = [...(list ?? [])];
  if (out.includes(value)) return { list: out, changed: false };
  out.push(value);
  return { list: out, changed: true };
}

function managedComboFor(provider: string, model: string): OcxComboConfig {
  return {
    alias: model,
    ...(SUPPORTED_NATIVE_OPENAI_SLUGS.has(model) ? { nativeAlias: true } : {}),
    displayName: displayNameForMomoModel(model),
    targets: [{ provider, model }],
  };
}

function isManagedCombo(combo: OcxComboConfig | undefined, provider: string, model: string): boolean {
  return Boolean(combo
    && combo.alias === model
    && combo.targets?.length === 1
    && combo.targets[0]?.provider === provider
    && combo.targets[0]?.model === model);
}

export function applyMomoModelAutoSync(config: OcxConfig, modelIds: readonly string[]): MomoAutoSyncResult {
  const settings = effectiveAutoSyncConfig(config);
  const result: MomoAutoSyncResult = {
    enabled: settings.enabled,
    changed: false,
    fetched: modelIds.length,
    addedProviderModels: [],
    removedProviderModels: [],
    addedCombos: [],
    removedCombos: [],
    skipped: [],
    imagesProviderChanged: false,
  };
  if (!settings.enabled) return result;

  const comboAliasToId = new Map<string, string>();
  for (const [id, combo] of Object.entries(config.combos ?? {})) {
    if (typeof combo.alias !== "string") continue;
    const alias = combo.alias.trim();
    if (alias && !comboAliasToId.has(alias)) comboAliasToId.set(alias, id);
  }
  const providerModelSets = new Map<string, Set<string>>();
  const ensureProviderModelSet = (providerId: string, providerModels: string[] | undefined): Set<string> => {
    const existing = providerModelSets.get(providerId);
    if (existing) return existing;
    const next = new Set(providerModels ?? []);
    providerModelSets.set(providerId, next);
    return next;
  };
  const disabledModels = [...(config.disabledModels ?? [])];
  const disabledModelSet = new Set(disabledModels);
  const addDisabledModel = (model: string): boolean => {
    if (disabledModelSet.has(model)) return false;
    disabledModelSet.add(model);
    disabledModels.push(model);
    config.disabledModels = disabledModels;
    return true;
  };
  let writableCombos: Record<string, OcxComboConfig> | undefined;
  const ensureWritableCombos = (): Record<string, OcxComboConfig> => {
    if (writableCombos) return writableCombos;
    writableCombos = { ...(config.combos ?? {}) };
    config.combos = writableCombos;
    return writableCombos;
  };

  const uniqueModelIds = [...new Set(modelIds.map(id => id.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const currentModelSet = new Set(uniqueModelIds);
  for (const model of uniqueModelIds) {
    const classification = classifyMomoModelId(model, config);
    if (classification.kind === "unknown" || !classification.provider) {
      if (settings.exposeUnknownModels && providerExists(config, MOMO_RESPONSES_PROVIDER_ID) && MOMO_MODEL_ID_PATTERN.test(model)) {
        classification.kind = "text";
        classification.provider = MOMO_RESPONSES_PROVIDER_ID;
      } else {
        result.skipped.push({ model, kind: "unknown", reason: classification.reason });
        continue;
      }
    }

    if (classification.kind === "image") {
      if (!settings.includeImageModels) {
        result.skipped.push({ model, provider: classification.provider, kind: "image", reason: "image-sync-disabled" });
        continue;
      }
      const images = config.images ?? {};
      if (!images.provider) {
        config.images = { ...images, provider: classification.provider };
        result.imagesProviderChanged = true;
        result.changed = true;
      }
      continue;
    }

    const provider = config.providers[classification.provider];
    if (!provider) {
      result.skipped.push({ model, provider: classification.provider, kind: classification.kind, reason: "provider-missing" });
      continue;
    }
    const providerModels = provider.models ?? [];
    const providerModelSet = ensureProviderModelSet(classification.provider, provider.models);
    if (!providerModelSet.has(model)) {
      providerModelSet.add(model);
      providerModels.push(model);
      provider.models = providerModels;
      result.addedProviderModels.push({ model, provider: classification.provider, kind: "text" });
      result.changed = true;
    }
    if (settings.autoCreateCombos) {
      const combos = ensureWritableCombos();
      const existingComboId = comboAliasToId.get(model) ?? null;
      if (existingComboId) {
        if (addDisabledModel(routedSlug(classification.provider, model))) {
          result.changed = true;
        }
      }
      if (!existingComboId) {
        const comboId = momoAutoComboId(model);
        if (!Object.hasOwn(combos, comboId)) {
          combos[comboId] = managedComboFor(classification.provider, model);
          comboAliasToId.set(model, comboId);
          addDisabledModel(routedSlug(classification.provider, model));
          result.addedCombos.push({ model, provider: classification.provider, comboId, kind: "text" });
          result.changed = true;
        } else {
          result.skipped.push({ model, provider: classification.provider, comboId, kind: "text", reason: "combo-id-exists" });
        }
      }
    }
  }

  // The MOMO /models response is authoritative for models previously imported by this
  // scheduler. Remove only rows we own, leaving user-created provider models and combos intact.
  const legacyManagedModelIds = settings.managedModelIds.length > 0
    ? settings.managedModelIds
    : Object.values(config.combos ?? {}).flatMap(combo => {
      const target = combo.targets?.[0];
      return typeof combo.alias === "string"
        && target?.provider?.startsWith("momo-")
        && target.model === combo.alias
        ? [combo.alias]
        : [];
    });
  for (const model of legacyManagedModelIds) {
    if (currentModelSet.has(model)) continue;
    const classification = classifyMomoModelId(model, config);
    const providerId = classification.provider;
    if (providerId) {
      const provider = config.providers[providerId];
      if (provider?.models?.includes(model)) {
        provider.models = provider.models.filter(candidate => candidate !== model);
        result.removedProviderModels.push({ model, provider: providerId, kind: classification.kind, reason: "momo-model-removed" });
        result.changed = true;
      }
    }
    const comboId = momoAutoComboId(model);
    const combo = config.combos?.[comboId];
    if (providerId && isManagedCombo(combo, providerId, model)) {
      const combos = { ...(config.combos ?? {}) };
      delete combos[comboId];
      config.combos = combos;
      const hidden = routedSlug(providerId, model);
      config.disabledModels = (config.disabledModels ?? []).filter(candidate => candidate !== hidden);
      result.removedCombos.push({ model, provider: providerId, comboId, kind: classification.kind, reason: "momo-model-removed" });
      result.changed = true;
    }
  }

  config.momoModelAutoSync = {
    ...(config.momoModelAutoSync ?? {}),
    managedModelIds: uniqueModelIds,
  };

  return result;
}

function readMomoApiKey(config: OcxConfig): string | null {
  const provider = config.providers[MOMO_RESPONSES_PROVIDER_ID];
  const key = resolveEnvValue(provider?.apiKey)?.trim();
  return key || null;
}

function readModelIdsFromModelsPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) return [];
  const out: string[] = [];
  for (const item of (payload as { data: unknown[] }).data) {
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      const id = (item as { id: string }).id.trim();
      if (id) out.push(id);
    }
  }
  return out;
}

export async function fetchMomoModelIds(config: OcxConfig, deps: Pick<MomoModelAutoSyncRunDeps, "fetch"> = {}): Promise<string[]> {
  const apiKey = readMomoApiKey(config);
  if (!apiKey) return [];
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const response = await fetchImpl("https://momoapi.us/v1/models", {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`MOMO /v1/models returned HTTP ${response.status}`);
  const modelIds = readModelIdsFromModelsPayload(await response.json());
  // An empty or malformed roster is not positive evidence that every previously managed
  // model was retired. Fail closed so a transient gateway/schema problem cannot erase routing.
  if (modelIds.length === 0) throw new Error("MOMO /v1/models returned an empty or invalid model roster");
  return modelIds;
}

export async function runMomoModelAutoSync(config: OcxConfig, deps: MomoModelAutoSyncRunDeps = {}): Promise<MomoAutoSyncResult> {
  const settings = effectiveAutoSyncConfig(config);
  const disabled: MomoAutoSyncResult = {
    enabled: false,
    changed: false,
    fetched: 0,
    addedProviderModels: [],
    removedProviderModels: [],
    addedCombos: [],
    removedCombos: [],
    skipped: [],
    imagesProviderChanged: false,
  };
  if (!settings.enabled) return disabled;
  const modelIds = await fetchMomoModelIds(config, deps);
  const result = applyMomoModelAutoSync(config, modelIds);
  if (!result.changed) return result;

  (deps.saveConfig ?? saveConfigPreservingClaudeCode)(config);
  if (settings.autoRefreshCatalog) {
    await (deps.refreshCatalog ?? (async (nextConfig: OcxConfig) => {
      const sync = await syncModelsToCodex(undefined, nextConfig, null, undefined, { catalogEvenWhenNotInjected: true });
      if (!sync.ok && sync.status !== "catalog-only") throw new Error(sync.message);
    }))(config);
  }
  if (settings.notifyOnChanges) {
    deps.log?.log?.("[momo] model auto-sync added " + result.addedProviderModels.length + " provider model(s), removed " + result.removedProviderModels.length + ", added " + result.addedCombos.length + " combo(s), removed " + result.removedCombos.length + ".");
  }
  return result;
}

export function startMomoModelAutoSync(config: OcxConfig, deps: MomoModelAutoSyncSchedulerDeps = {}): MomoModelAutoSyncHandle | null {
  const settings = effectiveAutoSyncConfig(config);
  if (!settings.enabled) return null;
  const setIntervalImpl = deps.setInterval ?? setInterval;
  const clearIntervalImpl = deps.clearInterval ?? clearInterval;
  const setTimeoutImpl = deps.setTimeout ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeout ?? clearTimeout;
  let running = false;
  let stopped = false;
  const run = () => {
    if (running || stopped) return;
    running = true;
    void runMomoModelAutoSync(config, deps)
      .catch(error => deps.log?.warn?.(`[momo] model auto-sync failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  };
  const startupTimer = setTimeoutImpl(run, 0);
  startupTimer.unref?.();
  const interval = setIntervalImpl(run, settings.intervalMinutes * 60 * 1000);
  interval.unref?.();
  return {
    stop() {
      stopped = true;
      clearTimeoutImpl(startupTimer);
      clearIntervalImpl(interval);
    },
  };
}
