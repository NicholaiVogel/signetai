export interface ConcurrencyAdmission {
	acquire(): boolean;
	release(): void;
	inFlight(): number;
}

export function createConcurrencyAdmission(maxInFlight: number): ConcurrencyAdmission {
	if (!Number.isInteger(maxInFlight) || maxInFlight < 0) {
		throw new Error("maxInFlight must be a non-negative integer");
	}

	let active = 0;
	return {
		acquire(): boolean {
			if (active >= maxInFlight) return false;
			active += 1;
			return true;
		},
		release(): void {
			if (active > 0) active -= 1;
		},
		inFlight(): number {
			return active;
		},
	};
}
