import "server-only";
import { cookies } from "next/headers";
import { getIronSession, sealData, unsealData } from "iron-session";
import { createClient } from "redis";
import * as oidc from "openid-client";
import { HttpError } from "./policy";

const duration = 8 * 60 * 60;
type CookieSession = { id?: string; flow?: { state: string; nonce: string; verifier: string; started: number } };
type Tokens = { access: string; refresh?: string; expires: number; deadline: number };
let redis: ReturnType<typeof createClient> | undefined;
let connecting: Promise<void> | undefined;
let identity: Promise<oidc.Configuration> | undefined;

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configuration ${name} is required.`);
  return value;
}
export function appUrl() { return required("APP_URL"); }
function password() {
  const value = required("SESSION_PASSWORD");
  if (value.length < 32) throw new Error("SESSION_PASSWORD must contain at least 32 characters.");
  return value;
}
export async function session() {
  const secure = new URL(appUrl()).protocol === "https:";
  if (process.env.NODE_ENV === "production" && !secure && process.env.ALLOW_LOCAL_HTTP !== "true")
    throw new Error("HTTPS is required for production sessions.");
  return getIronSession<CookieSession>(await cookies(), {
    password: password(), cookieName: secure ? "__Host-drivecore" : "drivecore-local",
    ttl: duration, cookieOptions: { httpOnly: true, secure, sameSite: "lax", path: "/" }
  });
}
export async function cache() {
  if (!redis) {
    redis = createClient({ url: required("REDIS_URL"), disableOfflineQueue: true, commandsQueueMaxLength: 1000,
      socket: { connectTimeout: 5000 } });
    redis.on("error", error => console.error("Session store connection failed", error.name));
  }
  if (!redis.isOpen) {
    connecting ??= redis.connect().then(() => {}).finally(() => { connecting = undefined; });
    await connecting;
  }
  return redis;
}
export function provider() {
  identity ??= oidc.discovery(new URL(required("OIDC_ISSUER")), required("OIDC_CLIENT_ID"),
    required("OIDC_CLIENT_SECRET"), undefined, {
      execute: process.env.ALLOW_LOCAL_HTTP === "true" ? [oidc.allowInsecureRequests] : undefined,
      timeout: 8,
      [oidc.customFetch]: async (input, init) => {
        const url = new URL(input);
        const internal = process.env.OIDC_INTERNAL_ORIGIN;
        if (internal && url.origin === new URL(required("OIDC_ISSUER")).origin) {
          const target = new URL(internal);
          url.protocol = target.protocol; url.host = target.host;
        }
        const body = init.body instanceof Uint8Array ? new Uint8Array(init.body).buffer : init.body;
        return fetch(url, { ...init, body, signal: AbortSignal.timeout(8000) });
      }
    }).catch(error => { identity = undefined; throw error; });
  return identity;
}
export async function writeTokens(id: string, tokens: Tokens, existing = false) {
  const ttl = Math.floor((tokens.deadline - Date.now()) / 1000);
  if (ttl <= 0) throw new HttpError("Session expired. Sign in again.", 401);
  const value = await sealData(tokens, { password: password(), ttl });
  const client = await cache();
  const written = existing ? await client.set(`session:${id}`, value, { EX: ttl, XX: true }) :
    await client.set(`session:${id}`, value, { EX: ttl });
  if (!written) throw new HttpError("Session ended.", 401);
}
async function readTokens(id: string) {
  const value = await (await cache()).get(`session:${id}`);
  if (!value) throw new HttpError("Session expired. Sign in again.", 401);
  const tokens = await unsealData<Tokens>(value, { password: password() });
  if (!tokens.access || tokens.deadline <= Date.now()) throw new HttpError("Session expired. Sign in again.", 401);
  return tokens;
}
export async function establish(result: oidc.TokenEndpointResponse) {
  if (!result.access_token || !result.expires_in) throw new Error("OIDC provider did not return an expiring access token.");
  const cookie = await session();
  if (cookie.id) await (await cache()).del(`session:${cookie.id}`);
  cookie.id = crypto.randomUUID();
  await writeTokens(cookie.id, {
    access: result.access_token, refresh: result.refresh_token,
    expires: Date.now() + result.expires_in * 1000, deadline: Date.now() + duration * 1000
  });
  delete cookie.flow;
  await cookie.save();
}
export async function accessToken() {
  const cookie = await session();
  if (!cookie.id) throw new HttpError("Sign in to access operational records.", 401);
  const id = cookie.id;
  let tokens = await readTokens(id);
  if (tokens.expires > Date.now() + 30000) return tokens.access;
  const client = await cache();
  const lock = `refresh:${id}`, owner = crypto.randomUUID();
  if (!(await client.set(lock, owner, { NX: true, EX: 30 }))) {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      tokens = await readTokens(id);
      if (tokens.expires > Date.now() + 30000) return tokens.access;
    }
    throw new HttpError("Session refresh is busy. Retry shortly.", 503);
  }
  try {
    tokens = await readTokens(id);
    if (tokens.expires > Date.now() + 30000) return tokens.access;
    if (!tokens.refresh) throw new HttpError("Sign in again to renew your session.", 401);
    const refreshed = await oidc.refreshTokenGrant(await provider(), tokens.refresh);
    if (!refreshed.expires_in) throw new Error("Provider returned no access-token expiry.");
    await writeTokens(id, {
      ...tokens, access: refreshed.access_token, refresh: refreshed.refresh_token ?? tokens.refresh,
      expires: Date.now() + refreshed.expires_in * 1000
    }, true);
    return refreshed.access_token;
  } catch (error) {
    if (error instanceof oidc.ResponseBodyError && error.error === "invalid_grant") {
      await client.del(`session:${id}`);
      throw new HttpError("Identity session ended. Sign in again.", 401);
    }
    throw error;
  } finally {
    await client.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0",
      { keys: [lock], arguments: [owner] });
  }
}
export function failure(error: unknown) {
  const traceId = crypto.randomUUID();
  const status = error instanceof HttpError ? error.status : 503;
  console.error("DriveCore web operation failed", traceId, error instanceof Error ? error.name : "UnknownError");
  return Response.json({ title: error instanceof HttpError ? error.message : "Identity or platform unavailable. Retry or contact support.", status, traceId },
    { status, headers: { "Cache-Control": "no-store" } });
}
