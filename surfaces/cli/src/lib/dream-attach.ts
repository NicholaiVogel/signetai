import {
	Key,
	ProcessTerminal,
	ScrollView,
	TuiAltScreen,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { DaemonStreamResult } from "./daemon.js";

const MAX_VIEW_LINE_CHARS = 16_000;

export interface DreamingAttachSnapshot {
	readonly passId: string;
	readonly agentId: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly summary: string | null;
	readonly error: string | null;
	readonly cursor: number;
	readonly replayFrom: number | null;
	readonly replayTo: number | null;
	readonly tokensConsumed?: number | null;
	readonly tokensInput?: number | null;
	readonly tokensOutput?: number | null;
	readonly tokensCacheRead?: number | null;
	readonly tokensCacheWrite?: number | null;
	readonly tokensCost?: number | null;
	readonly mutationsApplied?: number | null;
	readonly mutationsSkipped?: number | null;
	readonly mutationsFailed?: number | null;
}

export interface DreamingAttachEvent {
	readonly passId: string;
	readonly agentId: string;
	readonly cursor: number;
	readonly timestamp: string;
	readonly type: string;
	readonly data: Readonly<Record<string, unknown>>;
}

export interface DreamingAttachGap {
	readonly requestedCursor: number;
	readonly availableFrom: number | null;
	readonly availableTo: number;
	readonly reason: string;
}

export interface DreamingAttachEnvelope {
	readonly type?: string;
	readonly passId?: string;
	readonly agentId?: string;
	readonly cursor?: number;
	readonly timestamp?: string;
	readonly data?: Readonly<Record<string, unknown>>;
	readonly snapshot?: DreamingAttachSnapshot;
	readonly event?: DreamingAttachEvent;
	readonly gap?: DreamingAttachGap;
}

export interface ParsedSseEvent {
	readonly event: string;
	readonly id: string | null;
	readonly data: string;
}

export function parseSseEventBlock(block: string): ParsedSseEvent | null {
	let event = "message";
	let id: string | null = null;
	const data: string[] = [];
	for (const rawLine of block.replace(/\r/g, "").split("\n")) {
		if (rawLine.startsWith(":")) continue;
		const separator = rawLine.indexOf(":");
		const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
		let value = separator === -1 ? "" : rawLine.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "id") id = value;
		else if (field === "data") data.push(value);
	}
	if (data.length === 0) return null;
	return { event, id, data: data.join("\n") };
}

export function parseDreamingAttachEnvelope(record: ParsedSseEvent): DreamingAttachEnvelope | null {
	try {
		const parsed: unknown = JSON.parse(record.data);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as DreamingAttachEnvelope;
	} catch {
		return null;
	}
}

function eventFromEnvelope(envelope: DreamingAttachEnvelope, sseEventName: string): DreamingAttachEvent | undefined {
	if (envelope.event) return envelope.event;
	if (
		sseEventName !== "snapshot" &&
		sseEventName !== "gap" &&
		sseEventName !== "error" &&
		typeof envelope.passId === "string" &&
		typeof envelope.agentId === "string" &&
		typeof envelope.cursor === "number" &&
		typeof envelope.timestamp === "string" &&
		envelope.data !== undefined
	) {
		return envelope as DreamingAttachEvent;
	}
	return undefined;
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function eventData(event: DreamingAttachEvent, key: string): unknown {
	return event.data[key];
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable]";
	}
}

function wrappedLines(value: string, width: number): string[] {
	return value.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

function formatTimestamp(value: string): string {
	const timestamp = Date.parse(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
	if (!Number.isFinite(timestamp)) return value;
	return new Date(timestamp).toLocaleTimeString();
}

function formatElapsed(startedAt: string): string {
	const timestamp = Date.parse(startedAt.replace(" ", "T") + (startedAt.includes("Z") ? "" : "Z"));
	if (!Number.isFinite(timestamp)) return "?";
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
	const hours = Math.floor(elapsedSeconds / 3_600);
	const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
	const seconds = elapsedSeconds % 60;
	return hours > 0
		? `${hours}h${String(minutes).padStart(2, "0")}m`
		: `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
function prettyJson(value: unknown): string[] {
	try {
		return (JSON.stringify(value, null, 2) ?? "null").split("\n");
	} catch {
		return [safeJson(value)];
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadValueLines(value: unknown): string[] {
	if (typeof value !== "string") return prettyJson(value);
	try {
		const parsed: unknown = JSON.parse(value);
		return prettyJson(parsed);
	} catch {
		return value.split("\n");
	}
}

function rawEvent(event: DreamingAttachEvent): unknown {
	return event.data.raw ?? event.data;
}

function formatAttachUsage(snapshot: DreamingAttachSnapshot): string {
	const number = new Intl.NumberFormat();
	const tokens =
		snapshot.tokensInput != null || snapshot.tokensConsumed != null
			? `tokens ${number.format(snapshot.tokensConsumed ?? snapshot.tokensInput ?? 0)} total · ${number.format(snapshot.tokensInput ?? 0)} in · ${number.format(snapshot.tokensOutput ?? 0)} out · cache ${number.format(snapshot.tokensCacheRead ?? 0)} read/${number.format(snapshot.tokensCacheWrite ?? 0)} write`
			: "token usage pending";
	const cost = snapshot.tokensCost == null ? "cost pending" : `$${snapshot.tokensCost.toFixed(6)}`;
	const mutations =
		snapshot.mutationsApplied != null || snapshot.mutationsSkipped != null || snapshot.mutationsFailed != null
			? `mutations ${snapshot.mutationsApplied ?? 0} applied/${snapshot.mutationsSkipped ?? 0} skipped/${snapshot.mutationsFailed ?? 0} failed`
			: "mutations pending";
	return `${tokens} · ${cost} · ${mutations}`;
}

export class DreamingAttachView implements Component {
	private snapshot: DreamingAttachSnapshot | undefined;
	private readonly events: DreamingAttachEvent[] = [];
	private rawDetail = false;
	private lastCursor = 0;
	private snapshotCursor = 0;
	private phase = "connecting";
	private model: string | undefined;
	private toolCallCount = 0;

	constructor(
		private readonly onDetach: () => void,
		private readonly onChange: () => void = () => {},
	) {}

	get isRawDetail(): boolean {
		return this.rawDetail;
	}

	get cursor(): number {
		return this.lastCursor;
	}

	applySnapshot(snapshot: DreamingAttachSnapshot): void {
		this.snapshot = snapshot;
		this.snapshotCursor = Math.max(this.snapshotCursor, snapshot.cursor);
		this.phase = snapshot.status;
		this.invalidateAndRender();
	}

	applyGap(gap: DreamingAttachGap): void {
		this.addNotice(
			`Replay gap (${gap.reason}): requested cursor ${gap.requestedCursor}; available ${gap.availableFrom ?? "none"}–${gap.availableTo}.`,
		);
	}

	applyEvent(event: DreamingAttachEvent): void {
		this.lastCursor = Math.max(this.lastCursor, event.cursor);
		this.events.push(event);
		if (event.type === "tool_start") this.toolCallCount += 1;
		if (this.events.length > 160) this.events.splice(0, this.events.length - 160);

		if (event.type === "thinking_delta") this.phase = "thinking";
		else if (event.type === "assistant_delta") this.phase = "responding";
		else if (event.type === "tool_start") this.phase = `tool: ${textValue(eventData(event, "toolName")) ?? "unknown"}`;
		else if (event.type === "tool_end" || event.type === "tool_trace") this.phase = "running";
		else if (event.type === "session_info") this.model = textValue(eventData(event, "model"));
		else if (event.type === "lifecycle") this.phase = textValue(eventData(event, "phase")) ?? "running";
		else if (event.type === "pass_completed" || event.type === "pass_failed")
			this.phase = textValue(eventData(event, "status")) ?? (event.type === "pass_completed" ? "completed" : "failed");

		this.invalidateAndRender();
	}

	applyMalformedEvent(): void {
		this.addNotice("Malformed event received; continuing with the next event.");
	}

	addConnectionMessage(message: string): void {
		this.addNotice(message);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onDetach();
			return;
		}
		if (matchesKey(data, Key.ctrl("v"))) {
			this.rawDetail = !this.rawDetail;
			this.invalidateAndRender();
		}
	}

	render(width: number): string[] {
		const snapshot = this.snapshot;
		const header = snapshot
			? [
					`╭─ Dreaming · ${this.phase.toUpperCase()}`,
					`│ pass ${snapshot.passId}  ·  agent ${snapshot.agentId}  ·  model ${this.model ?? "pending"}`,
					`│ ${snapshot.mode}  ·  ${formatElapsed(snapshot.startedAt)} elapsed  ·  ${this.toolCallCount} observed tool calls  ·  cursor ${Math.max(this.lastCursor, this.snapshotCursor)}`,
					`│ ${formatAttachUsage(snapshot)}`,
					`├─ Activity  ${this.rawDetail ? "[event data]" : "[Ctrl+V: inspect raw event data]"}`,
					...(snapshot.summary ? [`│   Summary: ${snapshot.summary}`] : []),
					...(snapshot.error ? [`│   Error: ${snapshot.error}`] : []),
				]
			: ["╭─ Dreaming · CONNECTING", "├─ Activity"];
		const output = [...header, ...this.renderEvents(this.events.slice(-50)), "", "Ctrl+C detach · pass continues"];
		return output.flatMap((line) =>
			wrappedLines(line.slice(0, MAX_VIEW_LINE_CHARS), Math.max(1, width)).map((wrapped) =>
				truncateToWidth(wrapped, Math.max(1, width), "…"),
			),
		);
	}

	invalidate(): void {}

	private renderEvents(events: readonly DreamingAttachEvent[]): string[] {
		const output: string[] = [];
		for (let index = 0; index < events.length; index += 1) {
			const event = events[index];
			if (!event) continue;
			const time = formatTimestamp(event.timestamp);
			if (event.type === "thinking_delta") {
				let text = textValue(eventData(event, "delta")) ?? "";
				const reasoningEvents = [event];
				while (events[index + 1]?.type === "thinking_delta") {
					index += 1;
					const nextEvent = events[index];
					if (nextEvent) {
						text += textValue(eventData(nextEvent, "delta")) ?? "";
						reasoningEvents.push(nextEvent);
					}
				}
				output.push(`│ ${time}  Model reasoning`);
				output.push(
					...text
						.slice(0, MAX_VIEW_LINE_CHARS)
						.split("\n")
						.map((line) => `│   ${line}`),
				);
				if (this.rawDetail) {
					for (const reasoningEvent of reasoningEvents) output.push(...this.renderRaw(reasoningEvent));
				}
				continue;
			}
			if (event.type === "assistant_delta") {
				let text = textValue(eventData(event, "delta")) ?? "";
				const assistantEvents = [event];
				let candidateIndex = index + 1;
				while (candidateIndex < events.length) {
					while (events[candidateIndex]?.type === "message_update") candidateIndex += 1;
					if (events[candidateIndex]?.type !== "assistant_delta") break;
					while (index + 1 < candidateIndex) {
						index += 1;
						const hiddenEvent = events[index];
						if (hiddenEvent) assistantEvents.push(hiddenEvent);
					}
					index = candidateIndex;
					const nextEvent = events[index];
					if (nextEvent) {
						text += textValue(eventData(nextEvent, "delta")) ?? "";
						assistantEvents.push(nextEvent);
					}
					candidateIndex = index + 1;
				}
				output.push(`│ ${time}  Assistant`);
				output.push(
					...text
						.slice(0, MAX_VIEW_LINE_CHARS)
						.split("\n")
						.map((line) => `│   ${line}`),
				);
				if (this.rawDetail) {
					for (const assistantEvent of assistantEvents) output.push(...this.renderRaw(assistantEvent));
				}
				continue;
			}
			if (event.type === "attach_notice") {
				output.push(`│ ${time}  ! ${textValue(eventData(event, "message")) ?? "Notice"}`);
				continue;
			}
			if (event.type === "tool_start") {
				const tool = textValue(eventData(event, "toolName")) ?? "unknown tool";
				output.push(`│ ${time}  ▶ ${tool}`);
				output.push(...this.renderPayload(event));
			} else if (event.type === "tool_progress") {
				const tool = textValue(eventData(event, "toolName")) ?? "tool";
				output.push(`│ ${time}  ↳ ${tool} · progress`);
				output.push(...this.renderPayload(event));
			} else if (event.type === "tool_end") {
				const tool = textValue(eventData(event, "toolName")) ?? "unknown tool";
				const success = eventData(event, "success") === true;
				output.push(`│ ${time}  ${success ? "✓" : "✗"} ${tool} · ${success ? "completed" : "failed"}`);
				output.push(...this.renderPayload(event));
			} else if (event.type === "tool_trace") {
				const tool = textValue(eventData(event, "toolName")) ?? "unknown tool";
				const success = eventData(event, "success") === true;
				const latency = eventData(event, "latencyMs");
				output.push(
					`│ ${time}  ${success ? "✓" : "✗"} ${tool} · ${typeof latency === "number" ? `${latency} ms` : "trace"}`,
				);
				output.push(...this.renderPayload(event));
			} else if (event.type === "session_info") {
				output.push(`│ ${time}  Session ready · ${this.model ?? "model unavailable"}`);
				if (this.rawDetail) output.push(...this.renderRaw(event));
			} else if (event.type === "pass_completed" || event.type === "pass_failed") {
				const status =
					textValue(eventData(event, "status")) ?? (event.type === "pass_completed" ? "completed" : "failed");
				output.push(`│ ${time}  ${event.type === "pass_completed" ? "✓" : "✗"} Pass ${status}`);
				const summary = textValue(eventData(event, "summary"));
				const error = textValue(eventData(event, "error"));
				if (summary) output.push(`│   ${summary}`);
				if (error) output.push(`│   Error: ${error}`);
			} else if (
				event.type === "lifecycle" ||
				event.type === "agent_start" ||
				event.type === "agent_end" ||
				event.type === "turn_start" ||
				event.type === "turn_end"
			) {
				const label = textValue(eventData(event, "eventType")) ?? event.type.replaceAll("_", " ");
				output.push(`│ ${time}  · ${label}`);
				if (this.rawDetail) output.push(...this.renderRaw(event));
			} else if (event.type !== "message_update" && event.type !== "message_start" && event.type !== "message_end") {
				output.push(`│ ${time}  · ${event.type.replaceAll("_", " ")}`);
				if (this.rawDetail) output.push(...this.renderRaw(event));
			}
		}
		return output;
	}

	private renderPayload(event: DreamingAttachEvent): string[] {
		const raw = event.data.raw;
		if (this.rawDetail || !isRecord(raw)) return this.renderRaw(event);
		const fields =
			event.type === "tool_start"
				? [
						["arguments", "Input"],
						["input", "Input"],
					]
				: event.type === "tool_progress"
					? [
							["partialResult", "Progress"],
							["output", "Progress"],
							["content", "Progress"],
						]
					: event.type === "tool_trace"
						? [
								["output", "Result"],
								["result", "Result"],
							]
						: [
								["result", "Result"],
								["output", "Result"],
								["content", "Result"],
							];
		for (const [key, label] of fields) {
			const value = raw[key ?? ""];
			if (value !== undefined) {
				return [`│   ${label}`, ...payloadValueLines(value).map((line) => `│     ${line}`)];
			}
		}
		return prettyJson(raw).map((line) => `│   ${line}`);
	}

	private renderRaw(event: DreamingAttachEvent): string[] {
		return prettyJson(rawEvent(event)).map((line) => `│   ${line}`);
	}

	private addNotice(message: string): void {
		this.events.push({
			passId: this.snapshot?.passId ?? "",
			agentId: this.snapshot?.agentId ?? "",
			cursor: this.lastCursor,
			timestamp: new Date().toISOString(),
			type: "attach_notice",
			data: { message },
		});
		if (this.events.length > 160) this.events.splice(0, this.events.length - 160);
		this.invalidateAndRender();
	}

	private invalidateAndRender(): void {
		this.onChange();
	}
}

export interface FollowDreamingPassOptions {
	readonly passId: string;
	readonly fetchStream: (path: string, opts?: RequestInit & { timeout?: number }) => Promise<DaemonStreamResult>;
	readonly view: DreamingAttachView;
	readonly signal: AbortSignal;
	readonly streamTimeoutMs?: number;
	readonly maxReconnects?: number;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		const abort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", abort, { once: true });
		setTimeout(() => signal.removeEventListener("abort", abort), ms + 1);
	});
}

export async function readSseStream(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: ParsedSseEvent) => void,
	signal: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const cancelOnAbort = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	if (signal.aborted) cancelOnAbort();
	else signal.addEventListener("abort", cancelOnAbort, { once: true });
	const consume = (flush: boolean): void => {
		buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const event = parseSseEventBlock(block);
			if (event) onEvent(event);
			boundary = buffer.indexOf("\n\n");
		}
		if (flush && buffer.trim()) {
			const event = parseSseEventBlock(buffer);
			if (event) onEvent(event);
			buffer = "";
		}
	};
	try {
		while (!signal.aborted) {
			const result = await reader.read();
			if (result.done) break;
			buffer += decoder.decode(result.value, { stream: true });
			consume(false);
		}
		buffer += decoder.decode();
		consume(true);
	} finally {
		signal.removeEventListener("abort", cancelOnAbort);
		try {
			await reader.cancel();
		} catch {}
		reader.releaseLock();
	}
}

export class DreamingAttachError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DreamingAttachError";
	}
}

export async function followDreamingPass(options: FollowDreamingPassOptions): Promise<boolean> {
	const maxReconnects = options.maxReconnects ?? 5;
	const sleep = options.sleep ?? waitFor;
	let cursor = options.view.cursor;
	let reconnects = 0;
	let terminal = false;
	let connectionAbort: AbortController | undefined;
	try {
		while (!options.signal.aborted && !terminal) {
			const currentConnection = new AbortController();
			connectionAbort = currentConnection;
			const relayAbort = () => currentConnection.abort();
			options.signal.addEventListener("abort", relayAbort, { once: true });
			const query = new URLSearchParams();
			if (cursor > 0) query.set("after", String(cursor));
			const queryString = query.toString();
			const path = `/api/dream/passes/${encodeURIComponent(options.passId)}/events${queryString ? `?${queryString}` : ""}`;
			let result: DaemonStreamResult;
			try {
				result = await options.fetchStream(path, {
					signal: currentConnection.signal,
					headers: { Accept: "text/event-stream" },
					timeout: options.streamTimeoutMs,
				});
			} catch (error) {
				options.signal.removeEventListener("abort", relayAbort);
				if (connectionAbort === currentConnection) connectionAbort = undefined;
				if (options.signal.aborted) break;
				if (reconnects >= maxReconnects) {
					throw new DreamingAttachError(error instanceof Error ? error.message : String(error));
				}
				reconnects++;
				options.view.addConnectionMessage(`Live stream error; reconnecting (${reconnects}/${maxReconnects})...`);
				await sleep(Math.min(4_000, 250 * 2 ** (reconnects - 1)), options.signal);
				continue;
			}
			if (!result.ok) {
				options.signal.removeEventListener("abort", relayAbort);
				if (connectionAbort === currentConnection) connectionAbort = undefined;
				if (options.signal.aborted) break;
				if (reconnects >= maxReconnects) throw new DreamingAttachError(result.error ?? "Dreaming live stream failed");
				reconnects++;
				options.view.addConnectionMessage(`Live stream disconnected; reconnecting (${reconnects}/${maxReconnects})...`);
				await sleep(Math.min(4_000, 250 * 2 ** (reconnects - 1)), options.signal);
				continue;
			}
			if (!result.response.body) {
				options.signal.removeEventListener("abort", relayAbort);
				if (connectionAbort === currentConnection) connectionAbort = undefined;
				throw new DreamingAttachError("Dreaming live stream returned no body");
			}

			let streamError: unknown;
			try {
				await readSseStream(
					result.response.body,
					(record) => {
						const envelope = parseDreamingAttachEnvelope(record);
						if (!envelope) {
							options.view.applyMalformedEvent();
							return;
						}
						if (envelope.snapshot) {
							options.view.applySnapshot(envelope.snapshot);
							if (envelope.snapshot.status !== "running") terminal = true;
						}
						if (envelope.gap) options.view.applyGap(envelope.gap);
						const event = eventFromEnvelope(envelope, record.event);
						if (event) {
							options.view.applyEvent(event);
							if (event.type === "pass_completed" || event.type === "pass_failed") terminal = true;
						}
						const parsedCursor = record.id === null ? 0 : Number.parseInt(record.id, 10);
						if (Number.isSafeInteger(parsedCursor) && parsedCursor > cursor) cursor = parsedCursor;
					},
					currentConnection.signal,
				);
			} catch (error) {
				streamError = error;
			}
			options.signal.removeEventListener("abort", relayAbort);
			if (connectionAbort === currentConnection) connectionAbort = undefined;
			if (options.signal.aborted || terminal) break;
			if (reconnects >= maxReconnects) {
				throw new DreamingAttachError(
					streamError instanceof Error ? streamError.message : "Dreaming live stream ended unexpectedly",
				);
			}
			reconnects++;
			options.view.addConnectionMessage(
				streamError
					? `Live stream error; reconnecting (${reconnects}/${maxReconnects})...`
					: `Live stream ended; reconnecting (${reconnects}/${maxReconnects})...`,
			);
			await sleep(Math.min(4_000, 250 * 2 ** (reconnects - 1)), options.signal);
		}
	} finally {
		connectionAbort?.abort();
	}
	return terminal;
}

export function createDreamingAttachTui(view: DreamingAttachView): {
	readonly tui: TUI;
	readonly terminal: ProcessTerminal;
} {
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(new ScrollView(view, { follow: "end", primary: true, overscroll: "contain" }));
	tui.setFocus(view);
	return { tui, terminal };
}
