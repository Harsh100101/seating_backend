import { Prisma, PrismaClient } from '@prisma/client';

export interface TransactionRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  transactionOptions?: {
    maxWait?: number;
    timeout?: number;
  };
}
export function isTransientTransactionConflict(error: any): boolean {
  if (!error) return false;
  if (error.code === 'P2034' || error.code === 'P2028') return true;
  const message = String(error.message || '');
  return /write.?conflict|transient.?transaction|transaction.*conflict|unknowntransactioncommitresult|deadlock|could not serialize access|writeconflict/i.test(message);
}
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runTransactionWithRetry<T>(
  prisma: PrismaClient,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TransactionRetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 25);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(callback, options.transactionOptions as any);
    } catch (error) {
      if (!isTransientTransactionConflict(error) || attempt === maxAttempts) throw error;
      const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * baseDelayMs;
      await wait(exponentialDelay + jitter);
    }
  }

  throw new Error('Transaction retry exhausted.');
}

