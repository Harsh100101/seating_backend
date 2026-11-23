import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { getExplicitTestDatabaseUrl, verifyDisposableTestDatabase } from '../utils/test-database-guard.js';

// Test/browser validation mode is fail-closed. In particular, never inherit
// the checked-in Atlas DATABASE_URL when a real Prisma client is constructed
// by a test or browser validation server.
const isDisposableExecution = process.env.NODE_ENV === 'test'
  || process.env.TEST_ENVIRONMENT === 'disposable'
  || process.env.BROWSER_TEST_MODE === '1';

if (isDisposableExecution) {
  const explicitTestUrl = getExplicitTestDatabaseUrl();
  if (explicitTestUrl) process.env.DATABASE_URL = explicitTestUrl;
  else delete process.env.DATABASE_URL;
}

export interface PrismaPluginOptions {
  prisma?: PrismaClient;
}

const prismaPlugin: FastifyPluginAsync<PrismaPluginOptions> = async (fastify, options) => {
  if (isDisposableExecution && !options.prisma) {
    await verifyDisposableTestDatabase(getExplicitTestDatabaseUrl());
  }
  if (!options.prisma && !process.env.DATABASE_URL?.trim()) {
    throw new Error('FATAL: DATABASE_URL is required before constructing a Prisma client.');
  }
  const prisma = options.prisma ?? new PrismaClient();

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
};

export default fp(prismaPlugin, {
  name: 'prisma-plugin'
});
