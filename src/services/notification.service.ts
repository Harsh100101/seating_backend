export interface SeatNotificationPayload {
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  seatId: string;
  seatLabel: string;
  floorName?: string;
  buildingName?: string;
  action: 'ASSIGNED' | 'RELEASED' | 'TRANSFERRED' | 'PENDING_CONFLICT';
  reason?: string;
}

export type TransferNotificationType =
  | 'TRANSFER_PENDING'
  | 'TRANSFER_APPROVED'
  | 'TRANSFER_REJECTED'
  | 'TRANSFER_CANCELLED';

export interface DurableNotificationInput {
  recipientAdminId: string;
  transferRequestId: string;
  type: TransferNotificationType;
  title: string;
  message: string;
  dedupeKey: string;
}

/**
 * Persist an in-app notification in the same Prisma transaction as the
 * business mutation whenever the caller supplies a transaction client.
 * `upsert` makes retries and duplicate delivery attempts idempotent.
 */
export async function persistNotification(prisma: any, input: DurableNotificationInput) {
  // Keep this persistence boundary explicit. Notification event builders may
  // carry internal metadata (for example, a dedupe prefix), but Prisma must
  // receive only fields declared by the Notification model.
  const {
    recipientAdminId,
    transferRequestId,
    type,
    title,
    message,
    dedupeKey
  } = input;

  return prisma.notification.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      recipientAdminId,
      transferRequestId,
      type,
      title,
      message,
      dedupeKey,
      readAt: null
    }
  });
}

export class NotificationService {
  private static instance: NotificationService;
  private deliveryLog: Array<{ timestamp: string; payload: SeatNotificationPayload; status: string }> = [];

  private constructor() {}

  public static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  // Purely in-memory audit tracking — zero external network/SMTP dependencies
  public async notify(payload: SeatNotificationPayload): Promise<boolean> {
    try {
      this.deliveryLog.push({
        timestamp: new Date().toISOString(),
        payload,
        status: 'LOGGED_IN_MEMORY',
      });
      if (this.deliveryLog.length > 100) {
        this.deliveryLog.shift();
      }
      return true;
    } catch {
      return false;
    }
  }

  public getHistory(): Array<{ timestamp: string; payload: SeatNotificationPayload; status: string }> {
    return [...this.deliveryLog];
  }

  public clear(): void {
    this.deliveryLog = [];
  }
}

export const notificationService = NotificationService.getInstance();
