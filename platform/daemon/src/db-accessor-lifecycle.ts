export interface DbAccessorCloseParticipant {
	readonly name: string;
	readonly order: number;
	close(dbPath: string | undefined): void | Promise<void>;
}

const closeParticipants = new Map<string, DbAccessorCloseParticipant>();

/**
 * Register a daemon service whose state is coupled to the active database.
 * Foundational accessor code invokes this boundary without importing the
 * higher-level service itself.
 */
export function registerDbAccessorCloseParticipant(participant: DbAccessorCloseParticipant): void {
	if (closeParticipants.has(participant.name)) {
		throw new Error(`DB accessor close participant already registered: ${participant.name}`);
	}
	closeParticipants.set(participant.name, participant);
}

/** Run registered cleanup in explicit dependency order. */
export async function closeDbAccessorParticipants(dbPath: string | undefined): Promise<void> {
	const participants = [...closeParticipants.values()].sort(
		(left, right) => left.order - right.order || left.name.localeCompare(right.name),
	);
	for (const participant of participants) await participant.close(dbPath);
}
