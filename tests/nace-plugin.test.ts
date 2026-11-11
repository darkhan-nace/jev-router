import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { startFakeNace, type FakeNace } from "./fake-nace";

// index.ts imports the host's SDK, which is only installed under plugins/jev-router.
// The plugin's own logic is what runs here, so the SDK is stood in for. The module has
// to be mocked before index.ts loads, hence the dynamic import.
mock.module("@opencode/plugin", () => ({ Plugin: { define: (spec: unknown) => spec } }));
const { default: plugin } = (await import("../plugins/jev-router/index")) as { default: { setup: (ctx: any) => Promise<void> } };

type Handler = (event: any) => unknown;

/** The slice of the OpenCode plugin context that setup touches. Every hook the plugin registers lands in `handlers`. */
function stubContext(options: Record<string, unknown>) {
  const handlers: Handler[] = [];
  const hook = async (_name: string, fn: Handler) => void handlers.push(fn);
  const noop = async () => undefined;
  const ctx = {
    options,
    model: { list: async () => [] },
    skill: { list: async () => ({ data: [{ name: "pdf-fill", description: "fill pdfs" }] }) },
    session: { hook, switchAgent: noop, context: noop },
    tool: { hook, list: async () => ({ data: [{ id: "shell", description: "run a command" }] }), transform: noop },
    permission: { hook },
  };
  return { ctx: ctx as any, handlers };
}

describe("the plugin when the provider is a typo", () => {
  let fake: FakeNace;
  let errors: string[];
  let errorSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  const saved = { ...process.env };
  beforeEach(() => {
    fake = startFakeNace();
    errors = [];
    errorSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    fetchSpy = spyOn(globalThis, "fetch");
    for (const k of Object.keys(process.env)) if (/^(JEV_|NACE_|TYPESAFE_|OPENROUTER_)/.test(k)) delete process.env[k];
    Object.assign(process.env, {
      NACE_API_KEY: "nace_sk_testkey",
      NACE_BASE_URL: `${fake.url}/v1`,
      TYPESAFE_API_KEY: "ts-key",
      TYPESAFE_ENDPOINT: fake.url,
    });
  });
  afterEach(() => {
    errorSpy.mockRestore();
    fetchSpy.mockRestore();
    fake.stop();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  async function setupAndFire(options: Record<string, unknown>) {
    const { ctx, handlers } = stubContext(options);
    await plugin.setup(ctx);
    for (const h of handlers) {
      await Promise.resolve(h({ messages: [{ role: "user", text: "fill the pdf form" }], system: [], action: "write", resources: ["a.txt"], tool: "shell", args: {}, input: {}, output: {} })).catch(() => undefined);
    }
  }

  test("JEV_PROVIDER=naec: setup returns, prints one line naming the valid values, and sends nothing anywhere", async () => {
    process.env["JEV_PROVIDER"] = "naec";
    await setupAndFire({});
    expect(errors).toEqual([
      '[jev-router] unknown JEV_PROVIDER "naec" (valid values: typesafe, openrouter, nace); Jev calls will be skipped (fail open).',
    ]);
    expect(fake.requests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a typo in the provider option behaves the same", async () => {
    await setupAndFire({ provider: "naec" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown provider option "naec" (valid values: typesafe, openrouter, nace)');
    expect(fake.requests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("the same setup with the provider spelled right does call Nace", async () => {
    process.env["JEV_PROVIDER"] = "nace";
    await setupAndFire({});
    expect(errors.filter((e) => /unknown|No API key/.test(e))).toEqual([]);
    expect(fake.requests.length).toBeGreaterThan(0);
  });
});
