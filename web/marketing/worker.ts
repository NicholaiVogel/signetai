/**
 * Asset worker for the marketing site.
 *
 * Static assets are served natively by the Workers assets layer (which also
 * applies `_headers`); requests that do not match an asset fall through to
 * this handler.
 *
 * The embedded dashboard demo needs framing permissions (X-Frame-Options:
 * SAMEORIGIN, CSP frame-ancestors 'self') so Showcase.astro can iframe it.
 * The native assets layer ignores per-path `_headers` rules (only the `/*`
 * rule is applied in production), and asset paths never reach this handler —
 * so the demo is served at `/demo/*`, a non-asset path owned by this worker,
 * which internally serves the dashboard build out of the assets directory
 * (files stay at /dashboard/*; only the entry document needs the framing
 * headers, subresources are loaded same-origin without framing).
 */
export default {
	async fetch(request: Request, env: { ASSETS: { fetch: (r: Request) => Promise<Response> } }): Promise<Response> {
		const url = new URL(request.url);
		const isDemo = url.pathname === "/demo" || url.pathname.startsWith("/demo/");
		if (!isDemo) return env.ASSETS.fetch(request);

		// Map /demo/* onto the dashboard build inside the assets directory.
		const assetUrl = new URL(url);
		const rest = url.pathname === "/demo" ? "/" : url.pathname.slice("/demo".length);
		assetUrl.pathname = `/dashboard${rest}`;
		const res = await env.ASSETS.fetch(new Request(assetUrl, request));

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
