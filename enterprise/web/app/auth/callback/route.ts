import * as oidc from "openid-client";
import { appUrl, establish, failure, provider, session } from "../../../lib/auth";
import { HttpError } from "../../../lib/policy";

export async function GET(request: Request) {
  try {
    const cookie = await session(), flow = cookie.flow;
    if (!flow || Date.now() - flow.started > 600000) throw new HttpError("Sign-in attempt expired. Start again.", 401);
    delete cookie.flow;
    await cookie.save();
    const callback = new URL("/auth/callback", appUrl());
    callback.search = new URL(request.url).search;
    const result = await oidc.authorizationCodeGrant(await provider(), callback, {
      pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true
    });
    await establish(result);
    return Response.redirect(new URL("/", appUrl()), 303);
  } catch (error) { return failure(error); }
}
