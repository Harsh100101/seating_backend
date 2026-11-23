import { describe, expect, it } from 'vitest';
import { persistNotification, notificationService } from '../src/services/notification.service.js';

const input = {
  recipientAdminId: '507f1f77bcf86cd799439011',
  transferRequestId: '507f1f77bcf86cd799439012',
  type: 'TRANSFER_PENDING' as const,
  title: 'Incoming transfer request',
  message: 'An employee is awaiting approval.',
  dedupeKey: 'transfer:request:pending:admin'
};

describe('persistNotification', () => {
  it('passes only Prisma Notification fields to upsert.create', async () => {
    const calls: any[] = [];
    const prisma = {
      notification: {
        upsert: async (args: any) => {
          calls.push(args);
          return args.create;
        }
      }
    };

    await persistNotification(prisma, { ...input, dedupePrefix: 'internal-only' } as any);

    expect(calls[0]).toEqual({
      where: { dedupeKey: input.dedupeKey },
      update: {},
      create: { ...input, readAt: null }
    });
    expect(calls[0].create).not.toHaveProperty('dedupePrefix');
  });

  it('keeps duplicate delivery idempotent by dedupeKey and recipient', async () => {
    const records = new Map<string, any>();
    const prisma = {
      notification: {
        upsert: async ({ where, create }: any) => {
          const existing = records.get(where.dedupeKey);
          if (existing) return existing;
          records.set(create.dedupeKey, { ...create, id: 'notification-1' });
          return records.get(create.dedupeKey);
        }
      }
    };

    await persistNotification(prisma, input);
    await persistNotification(prisma, input);

    expect(records.size).toBe(1);
    expect(records.get(input.dedupeKey).recipientAdminId).toBe(input.recipientAdminId);
  });
});

describe('NotificationService memory cap', () => {
  it('caps deliveryLog to a maximum of 100 entries', async () => {
    notificationService.clear();
    expect(notificationService.getHistory().length).toBe(0);

    for (let i = 1; i <= 150; i++) {
      await notificationService.notify({
        employeeId: `emp-${i}`,
        employeeName: `Employee ${i}`,
        employeeEmail: `emp${i}@company.com`,
        seatId: `seat-${i}`,
        seatLabel: `S-${i}`,
        action: 'ASSIGNED'
      });
    }

    const history = notificationService.getHistory();
    expect(history.length).toBe(100);
    // The oldest 50 entries (1..50) should have been shifted out; first item should be emp-51
    expect(history[0].payload.employeeId).toBe('emp-51');
    expect(history[99].payload.employeeId).toBe('emp-150');

    notificationService.clear();
    expect(notificationService.getHistory().length).toBe(0);
  });
});
