import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { momoProviderConfigs } from "../src/cli/momo";
import type { OcxParsedRequest } from "../src/types";

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

  test("publishes only the current coding catalog and Ox's supported efforts", () => {
    const responses = getProviderRegistryEntry("momo-responses")!;
    const claude = getProviderRegistryEntry("momo-claude")!;
    expect(responses.models).toContain("deepseek-v4-pro");
    expect(responses.models).not.toContain("grok-4.5");
    expect(responses.modelReasoningEfforts?.["ox-alpha-free"]).toEqual(["low", "high", "max"]);
    expect(claude.models).toEqual(["claude-opus-4-6-thinking"]);
  });
});
