/**
 * Agent ID resolution helpers.
 */

import type { AgentRosterReadPolicy } from "@signet/core";
import { getDbAccessor } from "./db-accessor";

export interface AgentScope {
	readonly readPolicy: AgentRosterReadPolicy;
	readonly policyGroup: string | null;
}

/**
 * Resolve default daemon agent ID from environment.
 */
export function defaultAgentId(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.SIGNET_AGENT_ID?.trim();
	return configured && configured.length > 0 ? configured : "default";
}

/**
 * Resolve the agent ID from a request body.
 * Falls back to parsing OpenClaw's "agent:{id}:{rest}" session key format.
 * Final fallback: configured daemon agent or "default".
 */
export function resolveAgentId(
	body: { agentId?: string; sessionKey?: string },
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicit = body.agentId?.trim();
	if (explicit) return explicit;
	const parts = (body.sessionKey ?? "").split(":");
	if (parts[0] === "agent" && parts[1]?.trim()) return parts[1].trim();
	return defaultAgentId(env);
}

export function resolveDaemonAgentId(env: NodeJS.ProcessEnv = process.env): string {
	return defaultAgentId(env);
}

function parseScopeValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text.length > 0 ? text : null;
}

function parseReadPolicy(value: unknown): AgentRosterReadPolicy {
	const policy = parseScopeValue(value);
	if (policy === "shared" || policy === "group" || policy === "isolated") return policy;
	return "isolated";
}

interface AgentScopeCacheEntry {
	readonly scope: AgentScope;
	readonly expiresAt: number;
}

const AGENT_SCOPE_CACHE_TTL_MS = 30_000;
const agentScopeCache = new Map<string, AgentScopeCacheEntry>();
const agentScopeReads = new Map<string, Promise<AgentScope>>();
let agentScopeGeneration = 0;

const isolatedScope: AgentScope = { readPolicy: "isolated", policyGroup: null };

function normalizedAgentId(agentId: string): string {
	return agentId.trim() || "default";
}

/** Drop the cached policy for one agent, or all policies after roster changes. */
export function invalidateAgentScopeCache(agentId?: string): void {
	agentScopeGeneration += 1;
	if (agentId === undefined) {
		agentScopeCache.clear();
		return;
	}
	agentScopeCache.delete(normalizedAgentId(agentId));
}

/**
 * Read an agent's policy through the async DB boundary.
 *
 * Scope reads are frequent on request paths, so unchanged policies are kept
 * briefly in-process. In-flight reads are coalesced, while explicit roster
 * mutations can invalidate the entry immediately.
 */
export async function getAgentScope(agentId: string): Promise<AgentScope> {
	const id = normalizedAgentId(agentId);
	while (true) {
		const generation = agentScopeGeneration;
		const cached = agentScopeCache.get(id);
		if (cached !== undefined && cached.expiresAt > Date.now()) return cached.scope;

		let read = agentScopeReads.get(id);
		if (read === undefined) {
			read = Promise.resolve()
				.then(() =>
					getDbAccessor().withReadDbAsync(
						(db) => {
							const row = db.prepare("SELECT read_policy, policy_group FROM agents WHERE id = ?").get(id);
							if (!row || typeof row !== "object") return isolatedScope;
							const readPolicy = parseReadPolicy("read_policy" in row ? row.read_policy : undefined);
							const policyGroup = parseScopeValue("policy_group" in row ? row.policy_group : undefined);
							return { readPolicy, policyGroup };
						},
						{ siteToken: "agent-id.ts:97", operation: "agent-scope.read" },
					),
				)
				.catch(() => isolatedScope)
				.then((scope) => {
					if (generation === agentScopeGeneration) {
						agentScopeCache.set(id, { scope, expiresAt: Date.now() + AGENT_SCOPE_CACHE_TTL_MS });
					}
					return scope;
				});
			agentScopeReads.set(id, read);
		}

		let scope: AgentScope;
		try {
			scope = await read;
		} finally {
			if (agentScopeReads.get(id) === read) agentScopeReads.delete(id);
		}
		if (generation === agentScopeGeneration) return scope;
		if (agentScopeReads.get(id) === read) agentScopeReads.delete(id);
	}
}

export async function ensureAgentRegistered(
	agentId: string,
	readPolicy: AgentRosterReadPolicy = "shared",
): Promise<void> {
	const id = normalizedAgentId(agentId);
	const now = new Date().toISOString();
	try {
		const created = await getDbAccessor().withWriteTxAsync(
			(db) => {
				const existing = db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id);
				db.prepare(
					`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
					 VALUES (?, ?, ?, NULL, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
				).run(id, id, readPolicy, now, now);
				return existing == null;
			},
			{ siteToken: "agent-id.ts:136", operation: "agent-scope.register" },
		);
		if (created) invalidateAgentScopeCache(id);
	} catch (err) {
		console.warn(
			`[agent-id] Failed to register agent "${id}" (non-fatal):`,
			err instanceof Error ? err.message : String(err),
		);
	}
}
