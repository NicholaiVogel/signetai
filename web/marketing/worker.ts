/**
 * Minimal asset worker for the marketing site.
 *
 * Static assets are served through the ASSETS binding; the only custom
 * behavior is the embedded dashboard demo at /dashboard/*, which needs
 * framing permissions (X-Frame-Options: SAMEORIGIN, CSP frame-ancestors
 * 'self') so Showcase.astro can iframe it. Workers static assets `_headers`
 * does not reliably apply per-path overrides (the site-wide DENY rule wins),
 * so the policy is enforced here instead — deterministically, and verified
 * with `wrangler dev`.
 */
export default {
	async fetch(request: Request, env: { ASSETS: { fetch: (r: Request) => Promise<Response> } }): Promise<Response> {
		const url = new URL(request.url);
		const res = await env.ASSETS.fetch(request);
		if (!url.pathname.startsWith("/dashboard/")) return res;

		// Same policy the demo was verified against locally; replaces the
		// site-wide CSP's frame-ancestors 'none' for the embed only.
		const headers = new Headers(res.headers);
		headers.set("X-Frame-Options", "SAMEORIGIN");
		headers.set(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
		);
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	},
};
