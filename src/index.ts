import { loadApplicationEnvironment, requireDatabaseUrl } from './config/environment.js';
import { buildServer } from './server.js';

loadApplicationEnvironment();
requireDatabaseUrl();

export async function start(): Promise<void> {
  const server = buildServer();
  const port = Number(process.env.PORT) || 3001;
  const host = process.env.HOST || '0.0.0.0';

  try {
    await server.listen({ port, host });
    server.log.info(`Backend listening on ${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // Graceful termination handlers
  const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}, closing server gracefully...`);
    try {
      await server.close();
      if (server.prisma) {
        await server.prisma.$disconnect();
      }
      process.exit(0);
    } catch (closeErr) {
      server.log.error(closeErr);
      try {
        if (server.prisma) {
          await server.prisma.$disconnect();
        }
      } catch (prismaErr) {
        server.log.error(prismaErr);
      }
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Start process execution
void start();

export { buildServer };
