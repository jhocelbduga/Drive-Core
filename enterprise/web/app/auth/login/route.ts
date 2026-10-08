import * as oidc from "openid-client";
import { appUrl, failure, provider, session } from "../../../lib/auth";

export async function GET() {
  try {
    const cookie = await session();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState(), nonce = oidc.randomNonce();
    cookie.flow = { verifier, state, nonce, started: Date.now() };
    await cookie.save();
    const url = oidc.buildAuthorizationUrl(await provider(), {
      redirect_uri: new URL("/auth/callback", appUrl()).href,
      scope: "openid profile email", state, nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256"
    });
    return Response.redirect(url, 303);
  } catch (error) { return failure(error); }
}
