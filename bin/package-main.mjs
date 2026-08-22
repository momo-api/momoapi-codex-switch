export const packageName = "@momo-api/momoapi-codex-switch";
export const cliCommand = "ocx";

export async function loadBunApi() {
  if (typeof Bun === "undefined") {
    throw new Error("The momoapi-codex-switch programmatic API requires the Bun runtime. Use `ocx` for the CLI entrypoint.");
  }
  return import("../src/index.ts");
}
