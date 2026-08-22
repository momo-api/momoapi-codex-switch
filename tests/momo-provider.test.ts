import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildResponseJSON } from "../src/bridge";
import { createGoogleAdapter } from "../src/adapters/google";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { parseRequest } from "../src/responses/parser";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { buildToolBridgeMaps } from "../src/server/responses";
import { applyMomoCodexModelAliases, applyMomoDesktopCompatibilityAliases, hideMomoTransportModelIds, momoProviderConfigs, removeMomoDesktopCompatibilityAliases } from "../src/cli/momo";
import { routeModel } from "../src/router";
import { filterCatalogVisibleModels } from "../src/codex/catalog";
import { catalogModelSlug } from "../src/codex/catalog/parsing";
import type { OcxParsedRequest } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const parsed = {
  modelId: "gemini-3.7-flash",
  stream: true,
  options: {},
  context: { messages: [{ role: "user", content: "Reply with MOMO_OK" }], tools: [] },
} as unknown as OcxParsedRequest;

describe("MOMO provider presets", () => {
  test("materialize the three protocol lanes", () => {
    for (const id of ["momo-responses", "momo-claude", "momo-gemini"]) {
      const entry = getProviderRegistryEntry(id);
      expect(entry).toBeDefined();
      const provider = providerConfigSeed(entry!);
      expect(provider.baseUrl).toBe(id === "momo-responses" ? "https://momoapi.us/v1" : "https://momoapi.us");
    }
  });

  test("uses MOMO Bearer auth on the native Gemini wire", async () => {
    const entry = getProviderRegistryEntry("momo-gemini")!;
    const provider = { ...providerConfigSeed(entry), apiKey: "momo-test-key" };
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    expect(request.url).toBe("https://momoapi.us/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse");
    expect(request.headers.Authorization).toBe("Bearer momo-test-key");
    expect(request.headers["x-goog-api-key"]).toBeUndefined();
  });

  test("shares one MOMO key across the three native provider adapters", () => {
    const providers = momoProviderConfigs("momo-test-key");
    expect(Object.keys(providers)).toEqual(["momo-responses", "momo-claude", "momo-gemini"]);
    expect(providers["momo-responses"]?.adapter).toBe("openai-responses");
    expect(providers["momo-claude"]?.adapter).toBe("anthropic");
    expect(providers["momo-gemini"]?.adapter).toBe("google");
    expect(Object.values(providers).every(provider => provider.apiKey === "momo-test-key")).toBe(true);
    expect(providers["momo-claude"]?.headers?.["User-Agent"]).toBe("momoapi-codex-switch");
  });

  test("routes DeepSeek through the established Chat tool-replay bridge", async () => {
    const provider = momoProviderConfigs("momo-test-key")["momo-responses"]!;
    const resolved = resolveWireProtocolOverride("momo-responses", "deepseek-v4-pro", provider, "responses");
    expect(resolved.adapter).toBe("openai-chat");

    const request = parseRequest({
      model: "momo-responses/deepseek-v4-pro",
      input: "Apply the patch.",
      stream: false,
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
    });
    const adapter = createOpenAIChatAdapter(resolved);
    const upstream = await adapter.buildRequest(request);
    const upstreamBody = JSON.parse(String(upstream.body)) as { tools?: Array<{ function?: { name?: string } }> };
    expect(upstream.url).toBe("https://momoapi.us/v1/chat/completions");
    expect(upstreamBody.tools?.[0]?.function?.name).toBe("apply_patch");

    const events = await adapter.parseResponse!(Response.json({
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_patch",
            type: "function",
            function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }), createTestTranslatorBudget());
    const maps = buildToolBridgeMaps(request);
    const replay = buildResponseJSON(events, request.modelId, {
      toolNsMap: maps.toolNsMap,
      declaredToolNames: maps.declaredToolNames,
      freeformToolNames: maps.freeformToolNames,
      toolSearchToolNames: maps.toolSearchToolNames,
    });
    expect(replay.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "custom_tool_call", name: "apply_patch" }),
    ]));
  });

  test("creates honest native aliases for the three Codex Desktop picker slots", () => {
    const combos = applyMomoDesktopCompatibilityAliases({ custom: { targets: [{ provider: "x", model: "y" }] } });
    expect(combos.custom).toEqual({ targets: [{ provider: "x", model: "y" }] });
    expect(combos["momo-desktop-deepseek"]).toMatchObject({
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      displayName: "MOMOAPI DeepSeek V4 Pro",
      targets: [{ provider: "momo-responses", model: "deepseek-v4-pro" }],
    });
    expect(combos["momo-desktop-claude"]?.targets).toEqual([{ provider: "momo-claude", model: "claude-opus-4-6-thinking" }]);
    expect(combos["momo-desktop-gemini"]?.targets).toEqual([{ provider: "momo-gemini", model: "gemini-3.7-flash" }]);
  });

  test("renames aliases created by the previous MOMO installer without replacing user edits", () => {
    const upgraded = applyMomoDesktopCompatibilityAliases({
      "momo-desktop-deepseek": {
        alias: "gpt-5.6-sol",
        nativeAlias: true,
        displayName: "MOMO DeepSeek V4 Pro",
        targets: [{ provider: "momo-responses", model: "deepseek-v4-pro" }],
      },
      "momo-desktop-claude": {
        alias: "gpt-5.6-terra",
        nativeAlias: true,
        displayName: "My Claude",
        targets: [{ provider: "momo-claude", model: "claude-opus-4-6-thinking" }],
      },
    });
    expect(upgraded["momo-desktop-deepseek"]?.displayName).toBe("MOMOAPI DeepSeek V4 Pro");
    expect(upgraded["momo-desktop-claude"]?.displayName).toBe("My Claude");
  });

  test("removes only unmodified compatibility aliases so native GPT slots return", () => {
    const aliases = applyMomoDesktopCompatibilityAliases({
      "momo-desktop-claude": {
        alias: "gpt-5.6-terra",
        nativeAlias: true,
        displayName: "My Claude",
        targets: [{ provider: "momo-claude", model: "claude-opus-4-6-thinking" }],
      },
    });
    const restored = removeMomoDesktopCompatibilityAliases(aliases);
    expect(restored["momo-desktop-deepseek"]).toBeUndefined();
    expect(restored["momo-desktop-gemini"]).toBeUndefined();
    expect(restored["momo-desktop-claude"]?.displayName).toBe("My Claude");
  });

  test("publishes short MOMO model names that route without an OpenAI account pool", () => {
    const config = {
      port: 10101,
      defaultProvider: "momo-responses",
      providers: momoProviderConfigs("momo-test-key"),
      combos: applyMomoCodexModelAliases({}),
      disabledModels: hideMomoTransportModelIds([]),
    } as never;

    expect(routeModel(config, "gpt-5.6-sol")).toMatchObject({
      providerName: "momo-responses",
      modelId: "gpt-5.6-sol",
      routeKind: "combo",
    });
    expect(routeModel(config, "deepseek-v4-pro")).toMatchObject({
      providerName: "momo-responses",
      modelId: "deepseek-v4-pro",
      routeKind: "combo",
    });
    expect(routeModel(config, "claude-opus-4-6-thinking")).toMatchObject({
      providerName: "momo-claude",
      modelId: "claude-opus-4-6-thinking",
      routeKind: "combo",
    });
    expect(routeModel(config, "gemini-3.7-flash")).toMatchObject({
      providerName: "momo-gemini",
      modelId: "gemini-3.7-flash",
      routeKind: "combo",
    });
    expect(config.disabledModels).toContain("momo-responses/gpt-5.6-sol");
  });

  test("catalog exposes the short aliases and hides MOMO transport-qualified duplicates", async () => {
    const config = {
      port: 10101,
      defaultProvider: "momo-responses",
      providers: momoProviderConfigs("momo-test-key"),
      combos: applyMomoCodexModelAliases({}),
      disabledModels: hideMomoTransportModelIds([]),
    } as never;
    // Provider discovery is separately exercised by the catalog suite. This unit
    // only asserts the local visibility policy and must not make a real network call.
    const models = filterCatalogVisibleModels([
      { provider: "momo-responses", id: "gpt-5.6-sol" },
      { provider: "momo-responses", id: "deepseek-v4-pro" },
      { provider: "momo-claude", id: "claude-opus-4-6-thinking" },
      { provider: "momo-gemini", id: "gemini-3.7-flash" },
      { provider: "combo", id: "momo-model-gpt-5-6-sol", alias: "gpt-5.6-sol", nativeAlias: true },
      { provider: "combo", id: "momo-model-deepseek-v4-pro", alias: "deepseek-v4-pro" },
      { provider: "combo", id: "momo-model-claude-opus-4-6-thinking", alias: "claude-opus-4-6-thinking" },
      { provider: "combo", id: "momo-model-gemini-3-7-flash", alias: "gemini-3.7-flash" },
    ] as never, config);
    const slugs = models.map(catalogModelSlug);

    expect(slugs).toContain("gpt-5.6-sol");
    expect(slugs).toContain("deepseek-v4-pro");
    expect(slugs).toContain("claude-opus-4-6-thinking");
    expect(slugs).toContain("gemini-3.7-flash");
    expect(slugs).not.toContain("momo-responses/gpt-5.6-sol");
    expect(slugs).not.toContain("momo-claude/claude-opus-4-6-thinking");
    expect(slugs).not.toContain("momo-gemini/gemini-3.7-flash");
  });

  test("publishes only the current coding catalog and Ox's supported efforts", () => {
    const responses = getProviderRegistryEntry("momo-responses")!;
    const claude = getProviderRegistryEntry("momo-claude")!;
    expect(responses.models).toContain("deepseek-v4-pro");
    expect(responses.models).not.toContain("grok-4.5");
    expect(responses.modelReasoningEfforts?.["ox-alpha-free"]).toEqual(["low", "high", "max"]);
    expect(claude.models).toEqual(["claude-opus-4-6-thinking"]);
  });
});
