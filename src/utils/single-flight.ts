export function createSingleFlight<TResult>(
	operation: () => Promise<TResult>
): () => Promise<TResult> {
	let inFlight: Promise<TResult> | null = null;

	return () => {
		if (inFlight) return inFlight;

		const current = Promise.resolve().then(operation);
		inFlight = current;
		current.then(
			() => {
				if (inFlight === current) inFlight = null;
			},
			() => {
				if (inFlight === current) inFlight = null;
			}
		);
		return current;
	};
}
