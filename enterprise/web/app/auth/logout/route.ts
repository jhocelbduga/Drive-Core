import { appUrl, cache, failure, session } from "../../../lib/auth";
import { sameOrigin } from "../../../lib/policy";

export async function POST(request: Request) {
  try {
    sameOrigin(request, appUrl());
    const cookie = await session();
    if (cookie.id) await (await cache()).del(`session:${cookie.id}`);
    cookie.destroy();
    return Response.redirect(new URL("/", appUrl()), 303);
  } catch (error) { return failure(error); }
}
