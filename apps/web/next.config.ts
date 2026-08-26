import type { NextConfig } from "next";

/**
 * Reverse-proxies `/api/*` to the backend (`plan.md` M11) — this is routing,
 * not logic: nothing about entries, extraction, or auth *decisions* moves
 * into this app, only where the bytes get forwarded (`requirements.md`
 * §7.1). The payoff is that the auth cookie the backend sets becomes
 * same-origin from the browser's point of view, with no CORS involved for
 * ordinary browser traffic at all.
 *
 * `API_INTERNAL_URL` is where this Next.js *server process* reaches the
 * API — typically `http://127.0.0.1:4319` in local dev, or an internal
 * address once both are deployed. This is distinct from
 * `NEXT_PUBLIC_API_URL`, which `lib/api.ts` uses as the *browser's* base and
 * defaults to the relative `/api` path this rewrite serves.
 */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4319";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_INTERNAL_URL}/:path*` }];
  },
};

export default nextConfig;
