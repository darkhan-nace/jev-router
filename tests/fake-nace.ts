// Local stand-in for a decisions endpoint. Records every request and answers with the
// Drex /v1/systemone shape, so tests can assert what the plugin and hooks put on the wire.

export interface Recorded {
  path: string;
  headers: Headers;
  body: any;
}

export interface FakeNace {
  url: string;
  requests: Recorded[];
  respond: (r: Recorded) => Response | Promise<Response>;
  stop: () => void;
}

export const REQUEST_ID = "req_0123456789abcdef0123456789abcdef";

/** Answers every question by type: a choice picks its first option, a noul says 0.8. */
export function drexAnswer(r: Recorded): Response {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries<any>(r.body.questions)) {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      const rest = (0.3 / Math.max(1, options.length - 1));
      const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : rest]));
      answers[id] = { type: "choice", choice: options[0], confidence: 0.7, probabilities };
    } else if (q.type === "score") {
      answers[id] = { type: "score", score: 1, legend: q.criteria, probabilities: {}, confidence: 0.5 };
    } else {
      answers[id] = { type: "noul", noul: 0.8 };
    }
  }
  return Response.json({
    model: r.body.model,
    answers,
    usage: { input_tokens: 42, output_tokens: 7 },
    evaluation_time_ms: 12.5,
    request_id: REQUEST_ID,
  });
}

export function drexError(status: number, type: string): Response {
  return Response.json(
    { error: { type, message: "secret-free message" }, request_id: REQUEST_ID },
    { status },
  );
}

export function startFakeNace(): FakeNace {
  const fake: FakeNace = {
    url: "",
    requests: [],
    respond: drexAnswer,
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const recorded: Recorded = {
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json().catch(() => null),
      };
      fake.requests.push(recorded);
      return fake.respond(recorded);
    },
  });
  fake.url = `http://127.0.0.1:${server.port}`;
  return fake;
}
