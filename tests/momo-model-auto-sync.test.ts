import { describe, expect, mock, test } from "bun:test";
import { comboConfigIssues } from "../src/combos";
import {
  applyMomoModelAutoSync,
  classifyMomoModelId,
  momoAutoComboId,
  runMomoModelAutoSync,
  startMomoModelAutoSync,
} from "../src/momo/model-auto-sync";
import type { OcxConfig } from "../src/types";

function momoConfig(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "momo-responses",
    providers: {
      "momo-responses": {
        adapter: "openai-responses",
        baseUrl: "https://momoapi.us/v1",
        apiKey: "sk-test",
        liveModels: false,
        models: ["gpt-5.5"],
      },
      "momo-claude": {
        adapter: "anthropic",
        baseUrl: "https://momoapi.us",
        apiKey: "sk-test",
        liveModels: false,
        models: [],
      },
      "momo-gemini": {
        adapter: "google",
        baseUrl: "https://momoapi.us",
        apiKey: "sk-test",
        liveModels: false,
        models: [],
      },
    },
    momoModelAutoSync: {
      enabled: true,
      intervalMinutes: 60,
      autoCreateCombos: true,
      autoRefreshCatalog: true,
      includeImageModels: true,
    },
    ...extra,
  } as OcxConfig;
}

describe("MOMO model auto-sync", () => {
  test("classifies MOMO model ids by runtime lane without dropping codex-auto-review", () => {
    const config = momoConfig();
    expect(classifyMomoModelId("codex-auto-review", config)).toMatchObject({ kind: "text", provider: "momo-responses" });
    expect(classifyMomoModelId("gpt-5.6-luna-lite", config)).toMatchObject({ kind: "text", provider: "momo-responses" });
    expect(classifyMomoModelId("deepseek-v4-pro", config)).toMatchObject({ kind: "text", provider: "momo-responses" });
    expect(classifyMomoModelId("claude-opus-4-8-thinking", config)).toMatchObject({ kind: "text", provider: "momo-claude" });
    expect(classifyMomoModelId("gemini-3.7-flash", config)).toMatchObject({ kind: "text", provider: "momo-gemini" });
    expect(classifyMomoModelId("gpt-image-2-momoapi", config)).toMatchObject({ kind: "image", provider: "momo-responses" });
  });

  test("adds new text models, creates short combos, hides transport slugs, and configures images relay", () => {
    const config = momoConfig();
    const result = applyMomoModelAutoSync(config, [
      "gpt-5.5",
      "gpt-5.6-luna-lite",
      "codex-auto-review",
      "claude-opus-4-8-thinking",
      "gemini-3.8-flash",
      "gpt-image-2-momoapi",
      "bad/model",
    ]);

    expect(result.changed).toBe(true);
    expect(result.addedProviderModels.map(row => row.model).sort()).toEqual([
      "claude-opus-4-8-thinking",
      "codex-auto-review",
      "gemini-3.8-flash",
      "gpt-5.6-luna-lite",
    ]);
    expect(config.providers["momo-responses"]?.models).toContain("gpt-5.6-luna-lite");
    expect(config.providers["momo-responses"]?.models).toContain("codex-auto-review");
    expect(config.providers["momo-claude"]?.models).toContain("claude-opus-4-8-thinking");
    expect(config.providers["momo-gemini"]?.models).toContain("gemini-3.8-flash");
    expect(config.providers["momo-responses"]?.models).not.toContain("gpt-image-2-momoapi");
    expect(config.images?.provider).toBe("momo-responses");

    const lunaCombo = config.combos?.[momoAutoComboId("gpt-5.6-luna-lite")];
    expect(lunaCombo).toMatchObject({
      alias: "gpt-5.6-luna-lite",
      targets: [{ provider: "momo-responses", model: "gpt-5.6-luna-lite" }],
    });
    expect(lunaCombo?.nativeAlias).toBeUndefined();
    expect(comboConfigIssues(momoAutoComboId("gpt-5.6-luna-lite"), lunaCombo, config.providers, { combos: config.combos })).toEqual([]);
    expect(config.combos?.[momoAutoComboId("codex-auto-review")]?.targets[0]).toEqual({
      provider: "momo-responses",
      model: "codex-auto-review",
    });
    expect(config.disabledModels).toContain("momo-responses/gpt-5.6-luna-lite");
    expect(config.disabledModels).toContain("momo-responses/codex-auto-review");
    expect(config.combos?.[momoAutoComboId("gpt-image-2-momoapi")]).toBeUndefined();
    expect(result.skipped).toContainEqual({ model: "bad/model", kind: "unknown", reason: "unsupported-public-model-id" });

    const again = applyMomoModelAutoSync(config, [
      "gpt-5.5",
      "gpt-5.6-luna-lite",
      "codex-auto-review",
      "claude-opus-4-8-thinking",
      "gemini-3.8-flash",
      "gpt-image-2-momoapi",
    ]);
    expect(again.changed).toBe(false);
    expect(again.addedProviderModels).toEqual([]);
    expect(again.addedCombos).toEqual([]);
  });

  test("does not hide provider models when combo creation is disabled", () => {
    const config = momoConfig({ momoModelAutoSync: { enabled: true, autoCreateCombos: false } });
    const result = applyMomoModelAutoSync(config, ["gpt-5.6-luna-lite"]);
    expect(result.changed).toBe(true);
    expect(config.providers["momo-responses"]?.models).toContain("gpt-5.6-luna-lite");
    expect(config.combos).toBeUndefined();
    expect(config.disabledModels ?? []).not.toContain("momo-responses/gpt-5.6-luna-lite");
  });

  test("retires only models previously managed by the MOMO roster", () => {
    const config = momoConfig({
      momoModelAutoSync: {
        enabled: true,
        catalogMode: "momo",
        autoCreateCombos: false,
        managedModelIds: ["gpt-5.6-luna-lite", "claude-opus-4-8-thinking"],
      },
      providers: {
        ...momoConfig().providers,
        "momo-responses": {
          ...momoConfig().providers["momo-responses"],
          models: ["gpt-5.5", "gpt-5.6-luna-lite", "manual-model"],
        },
        "momo-claude": {
          ...momoConfig().providers["momo-claude"],
          models: ["claude-opus-4-8-thinking"],
        },
      },
      combos: {
        [momoAutoComboId("gpt-5.6-luna-lite")]: {
          alias: "gpt-5.6-luna-lite",
          targets: [{ provider: "momo-responses", model: "gpt-5.6-luna-lite" }],
        },
        [momoAutoComboId("claude-opus-4-8-thinking")]: {
          alias: "claude-opus-4-8-thinking",
          targets: [{ provider: "momo-claude", model: "claude-opus-4-8-thinking" }],
        },
      },
    });

    const result = applyMomoModelAutoSync(config, ["gpt-5.5"]);

    expect(result.removedProviderModels.map(row => row.model).sort()).toEqual([
      "claude-opus-4-8-thinking",
      "gpt-5.6-luna-lite",
    ]);
    expect(result.removedCombos.map(row => row.model).sort()).toEqual([
      "claude-opus-4-8-thinking",
      "gpt-5.6-luna-lite",
    ]);
    expect(config.providers["momo-responses"]?.models).toEqual(["gpt-5.5", "manual-model"]);
    expect(config.providers["momo-claude"]?.models).toEqual([]);
    expect(config.combos).toEqual({});
    expect(config.momoModelAutoSync?.managedModelIds).toEqual(["gpt-5.5"]);
  });

  test("runMomoModelAutoSync fetches once, persists changed config, and refreshes catalog", async () => {
    const config = momoConfig();
    const fetch = mock(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: "Bearer sk-test" });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna-lite" }, { id: "codex-auto-review" }] }), { status: 200 });
    });
    const saveConfig = mock((_config: OcxConfig) => {});
    const refreshCatalog = mock(async (_config: OcxConfig) => {});

    const result = await runMomoModelAutoSync(config, { fetch, saveConfig, refreshCatalog });

    expect(result.changed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
  });

  test("disabled auto-sync does not fetch or mutate", async () => {
    const config = momoConfig({ momoModelAutoSync: { enabled: false } });
    const fetch = mock(async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna-lite" }] })));
    const result = await runMomoModelAutoSync(config, { fetch });
    expect(result.enabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(config.providers["momo-responses"]?.models).not.toContain("gpt-5.6-luna-lite");
  });

  test("scheduler starts immediately, repeats at the configured interval, and stops cleanly", () => {
    const config = momoConfig({ momoModelAutoSync: { enabled: true, intervalMinutes: 60 } });
    let startupCallback: (() => void) | undefined;
    let intervalCallback: (() => void) | undefined;
    const startupHandle = { unref: mock(() => {}) };
    const intervalHandle = { unref: mock(() => {}) };
    const setTimeoutMock = mock((callback: () => void, ms: number) => {
      startupCallback = callback;
      expect(ms).toBe(0);
      return startupHandle as unknown as ReturnType<typeof setTimeout>;
    });
    const setIntervalMock = mock((callback: () => void, ms: number) => {
      intervalCallback = callback;
      expect(ms).toBe(60 * 60 * 1000);
      return intervalHandle as unknown as ReturnType<typeof setInterval>;
    });
    const clearTimeoutMock = mock((_handle: ReturnType<typeof setTimeout>) => {});
    const clearIntervalMock = mock((_handle: ReturnType<typeof setInterval>) => {});

    const handle = startMomoModelAutoSync(config, {
      setTimeout: setTimeoutMock as unknown as typeof setTimeout,
      setInterval: setIntervalMock as unknown as typeof setInterval,
      clearTimeout: clearTimeoutMock as unknown as typeof clearTimeout,
      clearInterval: clearIntervalMock as unknown as typeof clearInterval,
    });

    expect(handle).not.toBeNull();
    expect(startupCallback).toBeInstanceOf(Function);
    expect(intervalCallback).toBeInstanceOf(Function);
    expect(startupHandle.unref).toHaveBeenCalledTimes(1);
    expect(intervalHandle.unref).toHaveBeenCalledTimes(1);

    handle?.stop();
    expect(clearTimeoutMock).toHaveBeenCalledWith(startupHandle as unknown as ReturnType<typeof setTimeout>);
    expect(clearIntervalMock).toHaveBeenCalledWith(intervalHandle as unknown as ReturnType<typeof setInterval>);
  });

  test("known native OpenAI aliases still require nativeAlias", () => {
    const config = momoConfig();
    const issues = comboConfigIssues("momo-model-gpt-5-5", {
      alias: "gpt-5.5",
      targets: [{ provider: "momo-responses", model: "gpt-5.5" }],
    }, config.providers);
    expect(issues.map(issue => issue.message)).toContain("bare aliases for known OpenAI native models require nativeAlias=true");
  });
});
