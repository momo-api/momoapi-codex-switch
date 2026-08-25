import { isMediaGenerationModelId, type CatalogModel } from "../codex/catalog/parsing";
import { CODEX_PROVIDER_MODEL_CATALOG_KIND } from "../codex/catalog/kinds";
import type { OcxComboConfig, OcxConfig, OcxProviderConfig } from "../types";

export const MOMO_PROVIDER_IDS = ["momo-responses", "momo-claude", "momo-gemini"] as const;
export type MomoProviderId = (typeof MOMO_PROVIDER_IDS)[number];

export function isMomoProviderId(value: string): value is MomoProviderId {
  return (MOMO_PROVIDER_IDS as readonly string[]).includes(value);
}

/** MOMO exposes image-named models through /images, not the Codex text model picker. */
export function isMomoImageModelId(modelId: string): boolean {
  return isMediaGenerationModelId(modelId)
    || /(?:^|[-_.])image(?:$|[-_.])/i.test(modelId);
}

/** MOMO Switch owns the whole public picker in this mode; OpenAI native rows stay absent. */
export function isMomoOnlyCatalog(
  config: Pick<OcxConfig, "momoModelAutoSync" | "providers">,
): boolean {
  return config.momoModelAutoSync?.enabled === true
    && config.momoModelAutoSync.catalogMode !== "mixed"
    && Object.hasOwn(config.providers, "momo-responses");
}

/**
 * Publish MOMO provider rows under the real model id while retaining their physical provider.
 * This is a catalog projection, not a failover/round-robin Combo.
 */
export function projectMomoPublicCatalogAliases(
  models: readonly CatalogModel[],
  config: Pick<OcxConfig, "momoModelAutoSync" | "providers">,
): CatalogModel[] {
  if (!isMomoOnlyCatalog(config)) return [...models];
  return models.flatMap(model => {
    if (!isMomoProviderId(model.provider)) return [model];
    if (isMomoImageModelId(model.id)) return [];
    return [{ ...model, alias: model.id, catalogKind: CODEX_PROVIDER_MODEL_CATALOG_KIND }];
  });
}

/** Resolve a bare public MOMO id before the router's native OpenAI-family fallback. */
export function resolveMomoBareModelProvider(
  config: Pick<OcxConfig, "momoModelAutoSync" | "providers">,
  modelId: string,
): { providerName: MomoProviderId; provider: OcxProviderConfig } | null {
  if (modelId.includes("/") || !isMomoOnlyCatalog(config)) return null;
  for (const providerName of MOMO_PROVIDER_IDS) {
    const provider = config.providers[providerName];
    if (!provider || provider.disabled === true || !provider.models?.includes(modelId)) continue;
    return { providerName, provider };
  }
  return null;
}

/** Exact fingerprint of the one-target aliases created by older MOMO Switch releases. */
export function isLegacyMomoModelAliasCombo(id: string, combo: OcxComboConfig | undefined): boolean {
  const alias = typeof combo?.alias === "string" ? combo.alias.trim() : "";
  const target = combo?.targets?.[0];
  return id.startsWith("momo-model-")
    && alias.length > 0
    && combo?.targets?.length === 1
    && target !== undefined
    && isMomoProviderId(target.provider)
    && target.model === alias;
}
