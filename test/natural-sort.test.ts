import { describe, expect, it } from 'vitest';
import { compareNaturally } from '../src/utils/natural-sort.js';

describe('natural workstation sorting', () => {
  it('orders numbered workstation labels by their numeric suffix', () => {
    expect(['WS-10', 'WS-2', 'WS-1'].sort(compareNaturally)).toEqual(['WS-1', 'WS-2', 'WS-10']);
  });

  it('compares status values consistently', () => {
    expect(compareNaturally('AVAILABLE', 'OCCUPIED')).toBeLessThan(0);
    expect(compareNaturally('OCCUPIED', 'AVAILABLE')).toBeGreaterThan(0);
  });
});
