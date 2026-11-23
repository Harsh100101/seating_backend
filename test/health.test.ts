import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { SEAT_TYPES, SEAT_STATUSES } from '@seating/shared';
import { createMockPrisma } from './mock-prisma.js';

describe('Backend Server Health Endpoint', () => {
  it('GET /api/health returns 200 OK and supported types/statuses', async () => {
    const server = buildServer({ prisma: createMockPrisma() as any });
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    expect(body.supportedSeatTypes).toEqual(SEAT_TYPES);
    expect(body.supportedSeatStatuses).toEqual(SEAT_STATUSES);
  });
});
