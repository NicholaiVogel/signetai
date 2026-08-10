/** Maximum time an in-process daemon request may wait for the HTTP surface. */
export const INTERNAL_FETCH_TIMEOUT_MS = 10_000;

/**
 * Keep daemon self-HTTP calls bounded so overload fails at the caller instead
 * of leaving an extra request pending until the process is restarted.
 */
export function fetchInternal(
	input: Parameters<typeof fetch>[0],
	init: RequestInit = {},
	timeoutMs = INTERNAL_FETCH_TIMEOUT_MS,
): Promise<Response> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
	return fetch(input, {
		...init,
		signal,
	});
}
