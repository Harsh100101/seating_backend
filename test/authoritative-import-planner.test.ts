import { describe, expect, it } from 'vitest';
import { groupSeatOperations } from '../src/services/authoritative-import.service.js';

describe('authoritative seat assignment graph', () => {
  it('keeps a two-seat swap in one atomic group', () => {
    const operations = groupSeatOperations([
      { employeeCode: 'A', currentSeatId: 'seat-1', targetSeatId: 'seat-2', targetOccupantCode: 'B' },
      { employeeCode: 'B', currentSeatId: 'seat-2', targetSeatId: 'seat-1', targetOccupantCode: 'A' }
    ]);

    expect(new Set(operations.map((operation) => operation.groupId)).size).toBe(1);
    expect(operations.every((operation) => operation.group === 'SWAP_OR_CHAIN')).toBe(true);
  });

  it('keeps a longer reassignment chain together', () => {
    const operations = groupSeatOperations([
      { employeeCode: 'A', currentSeatId: 'seat-1', targetSeatId: 'seat-2', targetOccupantCode: 'B' },
      { employeeCode: 'B', currentSeatId: 'seat-2', targetSeatId: 'seat-3', targetOccupantCode: 'C' },
      { employeeCode: 'C', currentSeatId: 'seat-3', targetSeatId: 'seat-1', targetOccupantCode: 'A' }
    ]);

    expect(new Set(operations.map((operation) => operation.groupId)).size).toBe(1);
    expect(operations[0].groupId).toMatch(/^SEAT_GROUP_/);
  });

  it('keeps explicit vacancy releases outside assignment graph groups', () => {
    const operations = groupSeatOperations([
      { action: 'SEAT_RELEASE', employeeCode: 'A', currentSeatId: 'seat-1', targetSeatId: null, groupId: 'SIMPLE' },
      { action: 'SEAT_ASSIGNMENT', employeeCode: 'B', currentSeatId: null, targetSeatId: 'seat-2' }
    ]);

    expect(operations[0].groupId).toBe('SIMPLE');
    expect(operations[1].groupId).toBe('SIMPLE');
  });
});
