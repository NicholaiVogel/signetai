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
	let closePromise: Promise<void> | undefined;

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

		close(dbPath: string | undefined): Promise<void> {
			if (closePromise !== undefined) return closePromise;

			// Set the gate and snapshot synchronously, before the first await, so a
			// late module registration cannot race an in-progress close and be
			// omitted from the participant snapshot.
			closeStarted = true;
			const participants = [...closeParticipants.values()].sort(
				(left, right) => left.order - right.order || left.name.localeCompare(right.name),
			);
			closePromise = (async () => {
				try {
					for (const participant of participants) await participant.close(dbPath);
				} finally {
					// The registry is process-scoped while accessors are replaceable. Keep
					// the gate closed for this close operation, then allow the next
					// accessor lifecycle to register any modules loaded in the meantime.
					closeStarted = false;
					closePromise = undefined;
				}
			})();
			return closePromise;
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
