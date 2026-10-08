export class HttpError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export function sameOrigin(request: Request, appUrl: string) {
  if (request.headers.get("origin") !== new URL(appUrl).origin)
    throw new HttpError("Cross-origin changes are not permitted.", 403);
}

export function allowedRoute(path: string, method: string) {
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const patterns: Record<string, RegExp[]> = {
    GET: [/^(national|me|hubs|products|orders)$/, new RegExp(`^(hubs|orders|stock|availability)/${uuid}$`)],
    POST: [/^(hubs|products|orders)$/, new RegExp(`^orders/${uuid}/(settle|cancel)$`), new RegExp(`^stock/${uuid}/receive$`)],
    PUT: [new RegExp(`^hubs/${uuid}/status$`), new RegExp(`^products/${uuid}/price$`)]
  };
  return patterns[method]?.some(pattern => pattern.test(path)) ?? false;
}

export function validKey(key: string | null) {
  if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key) ||
      key === "00000000-0000-0000-0000-000000000000")
    throw new HttpError("A nonempty UUID Idempotency-Key is required.", 400);
  return key;
}
