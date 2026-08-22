import { loadConfig, saveConfig } from "../config";
import { syncModelsToCodex } from "../codex/sync";
import { providerConfigSeed } from "../providers/derive";
import { getProviderRegistryEntry } from "../providers/registry";
import type { OcxComboConfig, OcxProviderConfig } from "../types";

const MOMO_PROVIDER_IDS = ["momo-responses", "momo-claude", "momo-gemini"] as const;

/**
 * Codex Desktop filters its picker to a small remote allowlist of native ids.
 * These explicit aliases occupy three allowlisted rows while retaining an honest
 * display label and routing each selection to its MOMO provider/model target.
 */
export const MOMO_DESKTOP_COMPATIBILITY_COMBOS: Readonly<Record<string, OcxComboConfig>> = Object.freeze({
  "momo-desktop-deepseek": {
    alias: "gpt-5.6-sol",
    nativeAlias: true,
    displayName: "MOMO DeepSeek V4 Pro",
    targets: [{ provider: "momo-responses", model: "deepseek-v4-pro" }],
  },
  "momo-desktop-claude": {
    alias: "gpt-5.6-terra",
    nativeAlias: true,
    displayName: "MOMO Claude Opus 4.6 Thinking",
    targets: [{ provider: "momo-claude", model: "claude-opus-4-6-thinking" }],
  },
  "momo-desktop-gemini": {
    alias: "gpt-5.6-luna",
    nativeAlias: true,
    displayName: "MOMO Gemini 3.7 Flash",
    targets: [{ provider: "momo-gemini", model: "gemini-3.7-flash" }],
  },
});

/** Add the Desktop-only compatibility aliases without replacing user-managed combos. */
export function applyMomoDesktopCompatibilityAliases(existing: Record<string, OcxComboConfig> | undefined): Record<string, OcxComboConfig> {
  const combos = { ...(existing ?? {}) };
  for (const [id, combo] of Object.entries(MOMO_DESKTOP_COMPATIBILITY_COMBOS)) {
    if (!Object.hasOwn(combos, id)) combos[id] = { ...combo, targets: [...combo.targets] };
  }
  return combos;
}

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

export async function runMomo(
  rawArgs: string[],
  dependencies: { findLiveProxy: () => Promise<{ port: number } | null> },
): Promise<number> {
  const args = [...rawArgs];
  const command = args.shift();
  if (command !== "setup") {
    console.error("Usage: ocx momo setup [--api-key <MOMO_KEY>] [--set-default] [--desktop-aliases] [--sync]");
    return 1;
  }

  const setDefault = consumeFlag(args, "--set-default");
  const desktopAliases = consumeFlag(args, "--desktop-aliases");
  const sync = consumeFlag(args, "--sync");
  const suppliedKey = consumeFlagValue(args, "--api-key");
  if (args.length > 0) {
    console.error("Usage: ocx momo setup [--api-key <MOMO_KEY>] [--set-default] [--desktop-aliases] [--sync]");
    return 1;
  }

  const apiKey = (suppliedKey ?? process.env.MOMO_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("MOMO API key is required. Pass --api-key or set MOMO_API_KEY.");
    return 1;
  }

  const config = loadConfig();
  Object.assign(config.providers, momoProviderConfigs(apiKey, config.providers));
  if (setDefault) config.defaultProvider = "momo-responses";
  if (desktopAliases) config.combos = applyMomoDesktopCompatibilityAliases(config.combos);
  saveConfig(config);

  console.log(`MOMO providers configured with key ${maskKey(apiKey)}:`);
  for (const id of MOMO_PROVIDER_IDS) console.log(`  - ${id}`);
  if (setDefault) console.log("Default provider: momo-responses");
  if (desktopAliases) console.log("Desktop compatibility aliases: DeepSeek V4 Pro, Claude Opus 4.6 Thinking, Gemini 3.7 Flash");

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
