import { describe, expect, test } from 'vitest';
import { sanitizeFileName } from './string-utils';

describe('sanitizeFileName', () => {
	test('limits long names so generated attachment paths remain usable', () => {
		const result = sanitizeFileName('a'.repeat(200));

		expect(result).toHaveLength(120);
	});

	test('trims whitespace after truncating', () => {
		const result = sanitizeFileName(`${'a'.repeat(119)} . extra`);

		expect(result).toBe('a'.repeat(119));
	});
});
