export interface DbAccessorCloseParticipant {
	readonly name: string;
	readonly order: number;
	close(dbPath: string | undefined): void | Promise<void>;
}

export interface DbAccessorLifecycle {
	register(participant: DbAccessorCloseParticipant): void;
	close(dbPath: string | undefined): Promise<void>;
}

/** Create an isolated close-participant registry for one accessor lifecycle. */
export function createDbAccessorLifecycle(): DbAccessorLifecycle {
	const closeParticipants = new Map<string, DbAccessorCloseParticipant>();
	let closeStarted = false;

	return {
		register(participant: DbAccessorCloseParticipant): void {
			if (closeStarted) {
				throw new Error(`DB accessor close participant registered after close started: ${participant.name}`);
			}
			if (closeParticipants.has(participant.name)) {
				throw new Error(`DB accessor close participant already registered: ${participant.name}`);
			}
			closeParticipants.set(participant.name, participant);
		},

		async close(dbPath: string | undefined): Promise<void> {
			// Set the gate before the first await so a late module registration cannot
			// race an in-progress close and be omitted from the participant snapshot.
			closeStarted = true;
			const participants = [...closeParticipants.values()].sort(
				(left, right) => left.order - right.order || left.name.localeCompare(right.name),
			);
			for (const participant of participants) await participant.close(dbPath);
		},
	};
}

const defaultLifecycle = createDbAccessorLifecycle();

export function registerDbAccessorCloseParticipant(participant: DbAccessorCloseParticipant): void {
	defaultLifecycle.register(participant);
}

/** Run registered cleanup in explicit dependency order. */
export async function closeDbAccessorParticipants(dbPath: string | undefined): Promise<void> {
	await defaultLifecycle.close(dbPath);
}
