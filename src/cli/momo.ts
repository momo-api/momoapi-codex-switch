import { loadConfig, saveConfig } from "../config";
import { syncModelsToCodex } from "../codex/sync";
import { routedSlug } from "../providers/slug-codec";
import { providerConfigSeed } from "../providers/derive";
import { getProviderRegistryEntry } from "../providers/registry";
import { isLegacyMomoModelAliasCombo, MOMO_PROVIDER_IDS } from "../momo/catalog-policy";
import { applyMomoModelAutoSync, fetchMomoModelIds } from "../momo/model-auto-sync";
import type { OcxComboConfig, OcxProviderConfig } from "../types";

const LEGACY_LOCAL_NEWAPI_PROVIDER_ID = "local-newapi";
const LEGACY_LOCAL_NEWAPI_BASE_URLS = new Set([
  "http://127.0.0.1:3000/v1",
  "http://localhost:3000/v1",
]);
const LEGACY_LOCAL_NEWAPI_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "gpt-5.5",
]);

type MomoModelAlias = {
  id: string;
  provider: (typeof MOMO_PROVIDER_IDS)[number];
  displayName: string;
  nativeAlias?: boolean;
};

// These are intentionally bare Codex model ids. MOMO Switch is a MOMO-only
// installation, so the picker should show the model customers chose, not the
// internal provider/model transport namespace.
const MOMO_MODEL_ALIASES: readonly MomoModelAlias[] = [
  { id: "gpt-5.4", provider: "momo-responses", displayName: "GPT-5.4", nativeAlias: true },
  { id: "gpt-5.4-mini", provider: "momo-responses", displayName: "GPT-5.4 Mini", nativeAlias: true },
  { id: "gpt-5.5", provider: "momo-responses", displayName: "GPT-5.5", nativeAlias: true },
  { id: "gpt-5.6-luna", provider: "momo-responses", displayName: "GPT-5.6 Luna", nativeAlias: true },
  { id: "gpt-5.6-terra", provider: "momo-responses", displayName: "GPT-5.6 Terra", nativeAlias: true },
  { id: "gpt-5.6-sol", provider: "momo-responses", displayName: "GPT-5.6 Sol", nativeAlias: true },
  { id: "deepseek-v4-flash-vision-exp", provider: "momo-responses", displayName: "DeepSeek V4 Flash Vision" },
  { id: "deepseek-v4-pro", provider: "momo-responses", displayName: "DeepSeek V4 Pro" },
  { id: "ox-alpha-free", provider: "momo-responses", displayName: "Ox Alpha Free" },
  { id: "claude-opus-4-6-thinking", provider: "momo-claude", displayName: "Claude Opus 4.6 Thinking" },
  { id: "gemini-3.7-flash", provider: "momo-gemini", displayName: "Gemini 3.7 Flash" },
];

const MOMO_RETIRED_MODEL_ALIASES: readonly MomoModelAlias[] = [
  { id: "deepseek-v4-flash", provider: "momo-responses", displayName: "DeepSeek V4 Flash" },
];

/**
 * Codex Desktop filters its picker to a small remote allowlist of native ids.
 * These explicit aliases occupy three allowlisted rows while retaining an honest
 * display label and routing each selection to its MOMO provider/model target.
 */
export const MOMO_DESKTOP_COMPATIBILITY_COMBOS: Readonly<Record<string, OcxComboConfig>> = Object.freeze({
  "momo-desktop-deepseek": {
    alias: "gpt-5.6-sol",
    nativeAlias: true,
    displayName: "MOMOAPI DeepSeek V4 Pro",
    targets: [{ provider: "momo-responses", model: "deepseek-v4-pro" }],
  },
  "momo-desktop-claude": {
    alias: "gpt-5.6-terra",
    nativeAlias: true,
    displayName: "MOMOAPI Claude Opus 4.6 Thinking",
    targets: [{ provider: "momo-claude", model: "claude-opus-4-6-thinking" }],
  },
  "momo-desktop-gemini": {
    alias: "gpt-5.6-luna",
    nativeAlias: true,
    displayName: "MOMOAPI Gemini 3.7 Flash",
    targets: [{ provider: "momo-gemini", model: "gemini-3.7-flash" }],
  },
});

/** Add the Desktop-only compatibility aliases without replacing user-managed combos. */
export function applyMomoDesktopCompatibilityAliases(existing: Record<string, OcxComboConfig> | undefined): Record<string, OcxComboConfig> {
  const combos = { ...(existing ?? {}) };
  for (const [id, combo] of Object.entries(MOMO_DESKTOP_COMPATIBILITY_COMBOS)) {
    const current = combos[id];
    if (!current) {
      combos[id] = { ...combo, targets: [...combo.targets] };
      continue;
    }
    // Upgrade labels created by earlier MOMO installers, while leaving a user's
    // custom target, alias, or label untouched.
    const target = current.targets?.[0];
    const expectedTarget = combo.targets[0];
    const expectedDisplayName = combo.displayName ?? "";
    const oldManagedLabel = current.displayName === expectedDisplayName
      || current.displayName === expectedDisplayName.replace("MOMOAPI", "MOMO");
    if (current.alias === combo.alias
      && current.nativeAlias === true
      && current.targets?.length === 1
      && target?.provider === expectedTarget?.provider
      && target?.model === expectedTarget?.model
      && oldManagedLabel) {
      combos[id] = { ...current, displayName: expectedDisplayName };
    }
  }
  return combos;
}

/** Remove only unmodified aliases created by MOMO Switch releases 2.29.4-2.29.6. */
export function removeMomoDesktopCompatibilityAliases(existing: Record<string, OcxComboConfig> | undefined): Record<string, OcxComboConfig> {
  const combos = { ...(existing ?? {}) };
  for (const [id, combo] of Object.entries(MOMO_DESKTOP_COMPATIBILITY_COMBOS)) {
    const current = combos[id];
    const target = current?.targets?.[0];
    const expectedTarget = combo.targets[0];
    const expectedDisplayName = combo.displayName ?? "";
    const isManagedAlias = current?.alias === combo.alias
      && current.nativeAlias === true
      && current.targets?.length === 1
      && target?.provider === expectedTarget?.provider
      && target?.model === expectedTarget?.model
      && (current.displayName === expectedDisplayName
        || current.displayName === expectedDisplayName.replace("MOMOAPI", "MOMO"));
    if (isManagedAlias) delete combos[id];
  }
  return combos;
}

/** Remove one-target model aliases created by MOMO Switch 2.29.4-2.29.16. */
export function removeMomoCodexModelAliases(existing: Record<string, OcxComboConfig> | undefined): Record<string, OcxComboConfig> {
  const combos = removeMomoDesktopCompatibilityAliases(existing);
  for (const [id, combo] of Object.entries(combos)) {
    if (isLegacyMomoModelAliasCombo(id, combo)) delete combos[id];
  }
  return combos;
}

/** Upgrade cleanup: direct MOMO aliases need the physical provider rows enabled. */
export function showMomoTransportModelIds(existing: string[] | undefined): string[] {
  const hidden = new Set(existing ?? []);
  for (const model of MOMO_MODEL_ALIASES) hidden.delete(routedSlug(model.provider, model.id));
  for (const model of MOMO_RETIRED_MODEL_ALIASES) hidden.delete(routedSlug(model.provider, model.id));
  return [...hidden];
}

/** @deprecated MOMO provider rows are now projected directly; retained for API compatibility. */
export const applyMomoCodexModelAliases = removeMomoCodexModelAliases;
/** @deprecated Direct aliases require transport rows enabled; retained for API compatibility. */
export const hideMomoTransportModelIds = showMomoTransportModelIds;

function consumeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function consumeFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** Build the three native MOMO protocol lanes from one customer key. */
export function momoProviderConfigs(apiKey: string, existing: Record<string, OcxProviderConfig> = {}): Record<string, OcxProviderConfig> {
  const providers: Record<string, OcxProviderConfig> = {};
  for (const id of MOMO_PROVIDER_IDS) {
    const entry = getProviderRegistryEntry(id);
    if (!entry) throw new Error(`MOMO provider preset is missing: ${id}`);
    const previous = existing[id];
    providers[id] = {
      ...providerConfigSeed(entry),
      ...(previous?.selectedModels ? { selectedModels: [...previous.selectedModels] } : {}),
      ...(previous?.disabled !== undefined ? { disabled: previous.disabled } : {}),
      ...(previous?.modelCosts ? { modelCosts: previous.modelCosts } : {}),
      // momoapi.us accepts the native Anthropic Messages wire but blocks the
      // upstream SDK fingerprint that the generic adapter uses by default.
      ...(id === "momo-claude"
        ? { headers: { ...previous?.headers, "User-Agent": "momoapi-codex-switch" } }
        : {}),
      apiKey,
    };
  }
  return providers;
}

function normalizedBaseUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/g, "").toLowerCase();
}

function isLegacyLocalNewapiMomoProvider(provider: OcxProviderConfig | undefined): boolean {
  if (!provider) return false;
  const models = provider.models ?? [];
  return provider.adapter === "openai-responses"
    && LEGACY_LOCAL_NEWAPI_BASE_URLS.has(normalizedBaseUrl(provider.baseUrl))
    && models.length > 0
    && models.every(model => LEGACY_LOCAL_NEWAPI_MODELS.has(model));
}

/** Remove the old local NewAPI bridge created by early MOMO installer flows. */
export function removeLegacyLocalNewapiMomoProvider(existing: Record<string, OcxProviderConfig> | undefined): Record<string, OcxProviderConfig> {
  const providers = { ...(existing ?? {}) };
  if (isLegacyLocalNewapiMomoProvider(providers[LEGACY_LOCAL_NEWAPI_PROVIDER_ID])) {
    delete providers[LEGACY_LOCAL_NEWAPI_PROVIDER_ID];
  }
  return providers;
}

export async function runMomo(
  rawArgs: string[],
  dependencies: {
    findLiveProxy: () => Promise<{ port: number } | null>;
    fetch?: typeof fetch;
  },
): Promise<number> {
  const args = [...rawArgs];
  const command = args.shift();
  if (command !== "setup") {
    console.error("Usage: ocx momo setup [--api-key <MOMO_KEY>] [--set-default] [--desktop-aliases|--restore-desktop-aliases] [--sync]");
    return 1;
  }

  const setDefault = consumeFlag(args, "--set-default");
  const desktopAliases = consumeFlag(args, "--desktop-aliases");
  const restoreDesktopAliases = consumeFlag(args, "--restore-desktop-aliases");
  const sync = consumeFlag(args, "--sync");
  const suppliedKey = consumeFlagValue(args, "--api-key");
  if (desktopAliases && restoreDesktopAliases || args.length > 0) {
    console.error("Usage: ocx momo setup [--api-key <MOMO_KEY>] [--set-default] [--desktop-aliases|--restore-desktop-aliases] [--sync]");
    return 1;
  }

  const apiKey = (suppliedKey ?? process.env.MOMO_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("MOMO API key is required. Pass --api-key or set MOMO_API_KEY.");
    return 1;
  }

  const config = loadConfig();
  config.providers = removeLegacyLocalNewapiMomoProvider(config.providers);
  Object.assign(config.providers, momoProviderConfigs(apiKey, config.providers));
  config.combos = removeMomoCodexModelAliases(config.combos);
  config.disabledModels = showMomoTransportModelIds(config.disabledModels);
  // Codex itself sends no MOMO key. Keep that credential in the local Switch
  // and expose a separate loopback-only Responses endpoint for the custom
  // provider injected into Codex config.toml.
  const proxyPort = config.port ?? 10100;
  if (!config.unauthenticatedLoopbackListener?.enabled) {
    config.unauthenticatedLoopbackListener = {
      enabled: true,
      port: proxyPort === 10101 ? 10102 : 10101,
    };
  }
  config.momoModelAutoSync = {
    ...(config.momoModelAutoSync ?? {}),
    enabled: config.momoModelAutoSync?.enabled ?? true,
    catalogMode: config.momoModelAutoSync?.catalogMode ?? "momo",
    intervalMinutes: config.momoModelAutoSync?.intervalMinutes ?? 60,
    autoCreateCombos: false,
    autoRefreshCatalog: config.momoModelAutoSync?.autoRefreshCatalog ?? true,
    includeImageModels: config.momoModelAutoSync?.includeImageModels ?? true,
    notifyOnChanges: config.momoModelAutoSync?.notifyOnChanges ?? true,
    managedModelIds: config.momoModelAutoSync?.managedModelIds ?? MOMO_PROVIDER_IDS.flatMap(
      providerId => config.providers[providerId]?.models ?? [],
    ),
  };
  let fetchedModelCount: number | null = null;
  try {
    const liveModelIds = await fetchMomoModelIds(config, { fetch: dependencies.fetch });
    applyMomoModelAutoSync(config, liveModelIds);
    fetchedModelCount = liveModelIds.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`MOMO live model fetch deferred to the background scheduler: ${message}`);
  }
  if (setDefault) config.defaultProvider = "momo-responses";
  // Kept only as no-op compatibility flags for installers from 2.29.4-2.29.10.
  // MOMO Switch now always publishes short, real model names instead of three
  // misleading desktop-slot aliases.
  void desktopAliases;
  void restoreDesktopAliases;
  saveConfig(config);

  console.log(`MOMO providers configured with key ${maskKey(apiKey)}:`);
  for (const id of MOMO_PROVIDER_IDS) console.log(`  - ${id}`);
  if (setDefault) console.log("Default provider: momo-responses");
  if (config.unauthenticatedLoopbackListener?.enabled) {
    console.log(`Codex local-only endpoint: http://127.0.0.1:${config.unauthenticatedLoopbackListener.port}/v1`);
  }
  console.log("Codex model names: GPT-5.4, GPT-5.5, GPT-5.6, DeepSeek, Claude, Gemini, and Ox.");
  if (fetchedModelCount !== null) console.log(`MOMO live model roster loaded: ${fetchedModelCount}`);

  if (!sync) {
    console.log("Run `ocx sync` to publish the MOMO models to Codex.");
    return 0;
  }

  const live = await dependencies.findLiveProxy();
  const result = await syncModelsToCodex(live?.port, undefined, undefined, undefined, { catalogEvenWhenNotInjected: true });
  if (!result.ok && result.status !== "catalog-only") {
    console.error(result.message ?? "MOMO providers were saved, but Codex catalog sync failed.");
    return 1;
  }
  console.log("MOMO models synced to Codex.");
  return 0;
}
