import { describe, expect, test, vi } from 'vitest';

import { createSingleFlight } from './single-flight';

describe('createSingleFlight', () => {
	test('shares one in-flight operation across repeated calls', async () => {
		let resolveOperation!: (value: string) => void;
		const operation = vi.fn(() => new Promise<string>((resolve) => {
			resolveOperation = resolve;
		}));
		const run = createSingleFlight(operation);

		const first = run();
		const second = run();

		expect(second).toBe(first);
		await Promise.resolve();
		expect(operation).toHaveBeenCalledTimes(1);

		resolveOperation('saved');
		await expect(first).resolves.toBe('saved');
	});

	test('allows a new operation after success or failure', async () => {
		const operation = vi.fn()
			.mockResolvedValueOnce('first')
			.mockRejectedValueOnce(new Error('failed'))
			.mockResolvedValueOnce('third');
		const run = createSingleFlight(operation);

		await expect(run()).resolves.toBe('first');
		await expect(run()).rejects.toThrow('failed');
		await expect(run()).resolves.toBe('third');
		expect(operation).toHaveBeenCalledTimes(3);
	});
});
