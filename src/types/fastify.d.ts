import '@fastify/secure-session';
import { PrismaClient, UserRole } from '@prisma/client';

declare module '@fastify/secure-session' {
  interface SessionData {
    adminId: string;
    email: string;
    name: string;
    role: UserRole | string;
    actualRole?: UserRole | string;
    assignedUnitId?: string | null;
    departmentId?: string | null;
    employeeId?: string | null;
    authenticatedAt: number;
    [key: string]: any;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    sessionCookieName: string;
  }

  interface FastifyRequest {
    admin?: {
      id: string;
      email: string;
      name: string;
      role: UserRole | string;
      actualRole?: UserRole | string;
      assignedUnitId?: string | null;
      departmentId?: string | null;
      employeeId?: string | null;
      authenticatedAtMs?: number;
    };
  }
}

