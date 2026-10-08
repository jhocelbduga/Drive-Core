import { accessToken, appUrl, failure, required } from "../../../lib/auth";
import { allowedRoute, HttpError, sameOrigin, validKey } from "../../../lib/policy";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await context.params).path.join("/");
    if (!allowedRoute(path, request.method)) throw new HttpError("Route is not available.", 404);
    if (request.method !== "GET") sameOrigin(request, appUrl());
    const headers = new Headers({ Authorization: `Bearer ${await accessToken()}` });
    let body: string | undefined;
    if (request.method !== "GET") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError("JSON content is required.", 415);
      headers.set("Idempotency-Key", validKey(request.headers.get("idempotency-key")));
      headers.set("Content-Type", "application/json");
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError("JSON body is required.", 400);
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 65536) { await reader.cancel(); throw new HttpError("Request is too large.", 413); }
        chunks.push(value);
      }
      body = Buffer.concat(chunks).toString("utf8");
      try { JSON.parse(body); } catch { throw new HttpError("Malformed JSON body.", 400); }
    }
    const url = new URL(`/api/${path}`, required("GATEWAY_URL"));
    const query = new URL(request.url).searchParams;
    if (query.has("offset")) url.searchParams.set("offset", query.get("offset")!);
    const result = await fetch(url, { method: request.method, headers, body, cache: "no-store", signal: AbortSignal.timeout(12000), redirect: "error" });
    return new Response(result.body, { status: result.status, headers: {
      "Content-Type": result.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store"
    } });
  } catch (error) { return failure(error); }
}
export { proxy as GET, proxy as POST, proxy as PUT };
