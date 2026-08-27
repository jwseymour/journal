import type { NextConfig } from "next";

/**
 * Reverse-proxies `/api/:path*` to `apps/public-api` (`requirements.md`
 * §10, `plan.md` M14) — the same same-origin trick `apps/web/next.config.ts`
 * uses for the private API, for the same reason: the browser never needs
 * to know the public API's real address, and there is one fewer thing for
 * CORS to get right. Unlike the private app, there is no cookie riding on
 * this — the public API has no auth at all — so the same-origin proxy here
 * is purely a convenience, not something a session's correctness depends on.
 *
 * `PUBLIC_API_INTERNAL_URL` is where this Next.js *server process* reaches
 * `apps/public-api` — typically `http://127.0.0.1:4320` in local dev, or an
 * internal address once both are deployed.
 */
const PUBLIC_API_INTERNAL_URL = process.env.PUBLIC_API_INTERNAL_URL ?? "http://127.0.0.1:4320";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${PUBLIC_API_INTERNAL_URL}/:path*` }];
  },
};

export default nextConfig;
