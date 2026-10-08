import { appUrl, cache, failure, provider, required } from "../../../lib/auth";
export async function GET() {
  try {
    appUrl();
    await (await cache()).ping();
    await provider();
    const response = await fetch(new URL("/health/ready", required("GATEWAY_URL")), { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) return Response.json({ status: "not ready" }, { status: 503 });
    return Response.json({ status: "ready" });
  } catch (error) { return failure(error); }
}
