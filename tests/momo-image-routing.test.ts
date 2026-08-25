import { expect, test } from "bun:test";
import { selectImagesProvider } from "../src/providers/openai-sidecar";
import type { OcxConfig } from "../src/types";

const config = {
  port: 0,
  defaultProvider: "momo-responses",
  providers: {
    openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    },
    "momo-responses": {
      adapter: "openai-responses",
      baseUrl: "https://momoapi.us/v1",
      apiKey: "momo-key",
      authMode: "key",
    },
  },
  images: { provider: "momo-responses" },
  momoModelAutoSync: { enabled: true, managedModelIds: ["gpt-image-2-momoapi"] },
} as OcxConfig;

test("MOMO image models use MOMO while native image models keep the OpenAI sidecar", () => {
  const momo = selectImagesProvider(config, "gpt-image-2-momoapi");
  expect(momo.keyed?.providerName).toBe("momo-responses");

  const native = selectImagesProvider(config, "gpt-image-2");
  expect(native.keyed).toBeUndefined();
  expect(native.forwardCandidates.map(candidate => candidate.providerName)).toContain("openai");
});
