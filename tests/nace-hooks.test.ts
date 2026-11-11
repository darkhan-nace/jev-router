import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUEST_ID, drexError, startFakeNace, type FakeNace } from "./fake-nace";

const root = join(import.meta.dir, "..");
const hooks = join(root, ".cursor", "hooks");
const python = Bun.which("python3");

const ASK = {
  type: "choice",
  choice: "ask",
  confidence: 0.9,
  probabilities: { allow: 0.05, ask: 0.9, deny: 0.05 },
};

/** Run a hook the way Cursor does: the payload on stdin, the environment as given, JSON on stdout. */
async function runHook(script: string, payload: unknown, env: Record<string, string>) {
  const proc = Bun.spawn([python as string, join(hooks, script)], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout: JSON.parse(stdout), stderr };
}

describe("shared nace descriptor", () => {
  test("the plugin and the hooks read identical nace.json", () => {
    const plugin = readFileSync(join(root, "plugins", "jev-router", "nace.json"), "utf-8");
    expect(readFileSync(join(hooks, "nace.json"), "utf-8")).toBe(plugin);
  });

  test("the hooks report the plugin's version", () => {
    const pkg = JSON.parse(readFileSync(join(root, "plugins", "jev-router", "package.json"), "utf-8"));
    const client = readFileSync(join(hooks, "jev_client.py"), "utf-8");
    expect(client).toContain(`VERSION = "${pkg.version}"`);
  });
});

describe.skipIf(!python)("cursor hooks against nace", () => {
  let fake: FakeNace;
  beforeEach(() => {
    fake = startFakeNace();
  });
  afterEach(() => fake.stop());

  const nace = () => ({ JEV_PROVIDER: "nace", NACE_API_KEY: "nace_sk_testkey", NACE_BASE_URL: `${fake.url}/v1` });
  const payload = { command: "rm -rf build", cwd: "/work/app" };

  test("a verdict call carries the cursor attribution, key and pinned model", async () => {
    fake.respond = (r) => Response.json({
      model: r.body.model,
      answers: { verdict: ASK },
      usage: { input_tokens: 31, output_tokens: 5 },
      evaluation_time_ms: 9,
      request_id: REQUEST_ID,
    });
    const { stdout } = await runHook("jev_policy.py", payload, nace());
    const [r] = fake.requests;
    expect(r.path).toBe("/v1/systemone");
    expect(r.headers.get("x-nace-client")).toMatch(/^jev-router-cursor\/\d+\.\d+\.\d+$/);
    expect(r.headers.get("authorization")).toBe("Bearer nace_sk_testkey");
    expect(r.body.model).toBe("drex-v2.0");
    expect(Object.keys(r.body.questions)).toEqual(["verdict"]);
    expect(r.body.state.pending_action).toBe("rm -rf build");
    expect(stdout.permission).toBe("ask");
    expect(stdout.user_message).toContain("confidence 0.90");
  });

  test("the stop hooks make attributed calls too", async () => {
    await runHook("jev_verify.py", { status: "completed", summary: "done" }, nace());
    await runHook("jev_review.py", { status: "completed", summary: "changed auth" }, nace());
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    for (const r of fake.requests) expect(r.headers.get("x-nace-client")).toStartWith("jev-router-cursor/");
  });

  test("the default provider sends no nace header and stays on TYPESAFE_ENDPOINT", async () => {
    await runHook("jev_policy.py", payload, { TYPESAFE_API_KEY: "ts-key", TYPESAFE_ENDPOINT: fake.url });
    expect(fake.requests[0].path).toBe("/v1/systemone");
    expect(fake.requests[0].headers.get("x-nace-client")).toBeNull();
    expect(fake.requests[0].body.model).toBe("jev-latest");
  });

  test("a NACE_API_KEY alone does not switch the hooks to nace", async () => {
    await runHook("jev_policy.py", payload, { NACE_API_KEY: "nace_sk_testkey", NACE_BASE_URL: `${fake.url}/v1` });
    expect(fake.requests).toHaveLength(0);
  });

  test("a missing NACE_API_KEY allows, names the variable and calls nobody, even with other keys set", async () => {
    const { stdout, stderr } = await runHook("jev_policy.py", payload, {
      JEV_PROVIDER: "nace",
      TYPESAFE_API_KEY: "ts-key",
      TYPESAFE_ENDPOINT: fake.url,
    });
    expect(stdout).toEqual({ continue: true, permission: "allow" });
    expect(stderr).toContain("NACE_API_KEY is not set");
    expect(fake.requests).toHaveLength(0);
  });

  test("an unknown JEV_PROVIDER allows, says so and calls nobody", async () => {
    const { stdout, stderr } = await runHook("jev_policy.py", payload, {
      JEV_PROVIDER: "nacee",
      TYPESAFE_API_KEY: "ts-key",
      TYPESAFE_ENDPOINT: fake.url,
    });
    expect(stdout).toEqual({ continue: true, permission: "allow" });
    expect(stderr).toContain('unknown JEV_PROVIDER "nacee"');
    expect(fake.requests).toHaveLength(0);
  });

  test.each([
    [401, "authentication_error"],
    [422, "invalid_request_error"],
  ])("a %i allows and reports type and request id on stderr", async (status, type) => {
    fake.respond = () => drexError(status, type);
    const { stdout, stderr } = await runHook("jev_policy.py", payload, nace());
    expect(stdout).toEqual({ continue: true, permission: "allow" });
    expect(stderr).toContain(`nace request failed: ${status} ${type} request_id=${REQUEST_ID}`);
    expect(stderr).not.toContain("nace_sk_testkey");
    expect(fake.requests).toHaveLength(1);
  });

  test("a redirect is refused and the key never reaches the target", async () => {
    const target = startFakeNace();
    try {
      fake.respond = () => new Response(null, { status: 302, headers: { location: `${target.url}/v1/systemone` } });
      const { stdout, stderr } = await runHook("jev_policy.py", payload, nace());
      expect(stdout).toEqual({ continue: true, permission: "allow" });
      expect(stderr).toContain("nace request failed: 302");
      expect(target.requests).toHaveLength(0);
    } finally {
      target.stop();
    }
  });

  test("plain http to a non-loopback host sends nothing", async () => {
    const { stderr } = await runHook("jev_policy.py", payload, { ...nace(), NACE_BASE_URL: "http://203.0.113.9/v1" });
    expect(stderr).toContain("refusing to send the key to 203.0.113.9");
    expect(fake.requests).toHaveLength(0);
  });
});
