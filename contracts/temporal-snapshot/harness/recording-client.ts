// A stand-in for the Exa SDK client that records every method call by its
// dotted path (e.g. "search", "websets.items.list", "rawRequest") and returns
// canned responses. Checks use it to observe exactly what would have gone out.

export interface RecordedCall {
  path: string;
  args: unknown[];
}

export type Responder = (path: string, args: unknown[]) => unknown;

const defaultResponder: Responder = path => {
  const body = { requestId: 'recording-client', results: [] };
  if (path === 'rawRequest') {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }
  return body;
};

export function recordingClient(responder: Responder = defaultResponder) {
  const calls: RecordedCall[] = [];
  const node = (path: string): unknown =>
    new Proxy(function recorded() {}, {
      get(_target, prop) {
        // Keep the client from looking like a thenable when awaited.
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return node(path ? `${path}.${prop}` : prop);
      },
      apply(_target, _thisArg, args: unknown[]) {
        calls.push({ path, args });
        return Promise.resolve(responder(path, args));
      },
    });
  return { client: node('') as any, calls };
}
