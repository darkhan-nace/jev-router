import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  NACE_CLIENT,
  choiceMargin,
  confidence,
  decisionsRequest,
  naceUrlAllowed,
  parseProvider,
  ranked,
  resolveBackend,
  systemOne,
  type Question,
} from "../plugins/jev-router/jev";
import { REQUEST_ID, drexError, startFakeNace, type FakeNace } from "./fake-nace";

const questions: Record<string, Question> = {
  which: {
    type: "choice",
    instructions: "Which skill?",
    criteria: { "pdf-fill": "fill pdfs", "pptx-author": "write decks" },
  },
  "gate::acts_on_user_system": { type: "noul", instructions: "Acts on files?" },
};

describe("resolveBackend", () => {
  test("nace is chosen by the option or JEV_PROVIDER, with its own key, endpoint and model", () => {
    const env = { NACE_API_KEY: "nace_sk_x", NACE_BASE_URL: "https://console.nace.ai/v1", NACE_MODEL: "drex-latest" };
    for (const b of [resolveBackend({ provider: "nace" }, env), resolveBackend({}, { ...env, JEV_PROVIDER: "nace" })]) {
      expect(b).toEqual({
        provider: "nace",
        apiKey: "nace_sk_x",
        endpoint: "https://console.nace.ai/v1",
        model: "drex-latest",
      });
    }
  });

  test("a NACE_API_KEY alone never selects nace", () => {
    expect(resolveBackend({}, { NACE_API_KEY: "nace_sk_x" }).provider).toBe("typesafe");
    expect(resolveBackend({}, { NACE_API_KEY: "nace_sk_x", OPENROUTER_API_KEY: "sk-or" }).provider).toBe("openrouter");
  });

  test("typesafe and openrouter resolve as before", () => {
    expect(resolveBackend({}, { TYPESAFE_API_KEY: "ts", OPENROUTER_API_KEY: "sk-or" })).toEqual({
      provider: "typesafe",
      apiKey: "ts",
      endpoint: "",
      model: "jev-latest",
    });
    expect(resolveBackend({}, { OPENROUTER_API_KEY: "sk-or", TYPESAFE_ENDPOINT: "https://x" })).toEqual({
      provider: "openrouter",
      apiKey: "sk-or",
      endpoint: "https://x",
      model: "typesafe/jev-1.13",
    });
  });

  test("nace without NACE_API_KEY has no key, whatever other keys and endpoints are set", () => {
    const b = resolveBackend(
      { provider: "nace" },
      { TYPESAFE_API_KEY: "ts", OPENROUTER_API_KEY: "sk-or", TYPESAFE_ENDPOINT: "https://other", TYPESAFE_MODEL: "jev-latest", JEV_ENDPOINT: "https://other" },
    );
    expect(b).toEqual({ provider: "nace", apiKey: "", endpoint: "", model: "drex-v2.0" });
  });

  test("the option beats JEV_PROVIDER", () => {
    expect(resolveBackend({ provider: "openrouter" }, { JEV_PROVIDER: "nace" }).provider).toBe("openrouter");
  });

  test("an unknown provider throws instead of falling back", () => {
    expect(() => resolveBackend({ provider: "nacee" }, { TYPESAFE_API_KEY: "ts" })).toThrow('unknown provider "nacee"');
    expect(() => parseProvider("Drex")).toThrow();
    expect(parseProvider("  NACE ")).toBe("nace");
    expect(parseProvider("")).toBeUndefined();
  });
});

describe("decisionsRequest nace", () => {
  test("default is console.nace.ai /v1/systemone on drex-v2.0", () => {
    expect(decisionsRequest({ apiKey: "k", provider: "nace" })).toEqual({
      url: "https://console.nace.ai/v1/systemone",
      model: "drex-v2.0",
    });
  });
  test("endpoint and model overrides", () => {
    expect(decisionsRequest({ apiKey: "k", provider: "nace", endpoint: "https://drex.nace.ai/v1/", model: "drex-latest" })).toEqual({
      url: "https://drex.nace.ai/v1/systemone",
      model: "drex-latest",
    });
  });
});

describe("naceUrlAllowed", () => {
  test("https and loopback http only, no credentials in the url", () => {
    expect(naceUrlAllowed("https://console.nace.ai/v1/systemone")).toBe(true);
    expect(naceUrlAllowed("http://127.0.0.1:3000/v1/systemone")).toBe(true);
    expect(naceUrlAllowed("http://localhost:3000/v1/systemone")).toBe(true);
    expect(naceUrlAllowed("http://console.nace.ai/v1/systemone")).toBe(false);
    expect(naceUrlAllowed("https://user:pw@console.nace.ai/v1/systemone")).toBe(false);
    expect(naceUrlAllowed("not a url")).toBe(false);
  });
});

describe("systemOne against nace", () => {
  let fake: FakeNace;
  let errors: string[];
  let spy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    fake = startFakeNace();
    errors = [];
    spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  });
  afterEach(() => {
    spy.mockRestore();
    fake.stop();
  });
  const nace = () => ({ apiKey: "nace_sk_testkey", provider: "nace" as const, endpoint: `${fake.url}/v1`, timeoutMs: 2000 });

  test("sends the attribution header, bearer key, pinned model and the question ids", async () => {
    const res = await systemOne({ request: "fill the form" }, questions, nace());
    expect(res).not.toBeNull();
    const [r] = fake.requests;
    expect(r.path).toBe("/v1/systemone");
    expect(r.headers.get("x-nace-client")).toBe(NACE_CLIENT);
    expect(NACE_CLIENT).toMatch(/^jev-router-opencode\/\d+\.\d+\.\d+$/);
    expect(NACE_CLIENT.length).toBeLessThanOrEqual(64);
    expect(NACE_CLIENT).toMatch(/^[A-Za-z0-9 ._@+-]+\/[A-Za-z0-9 ._@+-]+$/);
    expect(r.headers.get("authorization")).toBe("Bearer nace_sk_testkey");
    expect(r.body.model).toBe("drex-v2.0");
    expect(Object.keys(r.body.questions)).toEqual(["which", "gate::acts_on_user_system"]);
    expect(r.body.state).toEqual({ request: "fill the form" });
  });

  test("keeps probabilities, the choice, the noul and the usage", async () => {
    const res = await systemOne({}, questions, nace());
    expect(res?.answers["which"].choice).toBe("pdf-fill");
    expect(ranked(res?.answers["which"])[0]).toEqual(["pdf-fill", 0.7]);
    expect(choiceMargin(res?.answers["which"])).toBeCloseTo(0.4);
    expect(confidence(res?.answers["which"].probabilities)).toBeCloseTo(0.4);
    expect(res?.answers["gate::acts_on_user_system"].noul).toBe(0.8);
    expect(res?.usage?.input_tokens).toBe(42);
    expect((res as any).request_id).toBe(REQUEST_ID);
  });

  test("typesafe sends no nace header", async () => {
    await systemOne({}, questions, { apiKey: "ts-key", endpoint: fake.url, timeoutMs: 2000 });
    expect(fake.requests[0].path).toBe("/v1/systemone");
    expect(fake.requests[0].headers.get("x-nace-client")).toBeNull();
  });

  test.each([
    [401, "authentication_error"],
    [422, "invalid_request_error"],
    [429, "rate_limit_error"],
  ])("a %i fails open with one stderr line naming type and request id", async (status, type) => {
    fake.respond = () => drexError(status, type);
    expect(await systemOne({}, questions, nace())).toBeNull();
    expect(errors).toEqual([`[jev-router] nace request failed: ${status} ${type} request_id=${REQUEST_ID}`]);
    expect(errors.join()).not.toContain("nace_sk_testkey");
    expect(errors.join()).not.toContain("secret-free message");
  });

  test("a provider failure never retries another provider", async () => {
    fake.respond = () => drexError(401, "authentication_error");
    await systemOne({}, questions, nace());
    expect(fake.requests).toHaveLength(1);
  });

  test("a timeout fails open and says so", async () => {
    fake.respond = () => new Promise<Response>((r) => setTimeout(() => r(new Response("{}")), 500));
    expect(await systemOne({}, questions, { ...nace(), timeoutMs: 50 })).toBeNull();
    expect(errors[0]).toMatch(/nace request failed: (AbortError|TimeoutError)/);
  });

  test("a redirect is refused and the key never reaches the target", async () => {
    const target = startFakeNace();
    try {
      fake.respond = () => new Response(null, { status: 307, headers: { location: `${target.url}/v1/systemone` } });
      expect(await systemOne({}, questions, nace())).toBeNull();
      expect(target.requests).toHaveLength(0);
    } finally {
      target.stop();
    }
  });

  test("plain http to a non-loopback host sends nothing", async () => {
    const res = await systemOne({}, questions, { ...nace(), endpoint: "http://203.0.113.9/v1" });
    expect(res).toBeNull();
    expect(errors[0]).toContain("refusing to send the key to http://203.0.113.9");
    expect(fake.requests).toHaveLength(0);
  });
});
