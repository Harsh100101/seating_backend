import { FastifyPluginAsync } from 'fastify';

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const user = request.admin;
    if (!user) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    const query = request.query as { page?: string; limit?: string; unreadOnly?: string };
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 25));
    const unreadFilter = { OR: [{ readAt: null }, { readAt: { isSet: false } }] };
    const where: any = {
      recipientAdminId: user.id,
      ...(query.unreadOnly === 'true' ? unreadFilter : {})
    };

    const [total, unreadCount, notifications] = await Promise.all([
      fastify.prisma.notification.count({ where }),
      fastify.prisma.notification.count({ where: { recipientAdminId: user.id, ...unreadFilter } }),
      fastify.prisma.notification.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          title: true,
          message: true,
          transferRequestId: true,
          readAt: true,
          createdAt: true,
          transferRequest: { select: { id: true, requestNumber: true, status: true } }
        }
      })
    ]);

    return reply.status(200).send({
      notifications,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      },
      unreadCount
    });
  });

  fastify.post('/read-all', async (request, reply) => {
    const user = request.admin;
    if (!user) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    const result = await fastify.prisma.notification.updateMany({
      where: { recipientAdminId: user.id, OR: [{ readAt: null }, { readAt: { isSet: false } }] },
      data: { readAt: new Date() }
    });
    return reply.status(200).send({ updated: result.count });
  });

  fastify.patch('/:id/read', async (request, reply) => {
    const user = request.admin;
    if (!user) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    const { id } = request.params as { id: string };
    const updated = await fastify.prisma.notification.updateMany({
      where: { id, recipientAdminId: user.id, OR: [{ readAt: null }, { readAt: { isSet: false } }] },
      data: { readAt: new Date() }
    });
    if (updated.count !== 1) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Notification not found' });
    }

    return reply.status(200).send(
      await fastify.prisma.notification.findUnique({ where: { id } })
    );
  });
};
