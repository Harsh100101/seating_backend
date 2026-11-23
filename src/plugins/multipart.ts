import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import fastifyMultipart from '@fastify/multipart';

const multipartPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: 25 * 1024 * 1024, // 25 MB max
      files: 1
    }
  });

  // Support raw text/csv and text/plain request bodies
  fastify.addContentTypeParser(
    ['text/csv', 'text/plain'],
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    }
  );
};

export default fp(multipartPlugin, {
  name: 'multipart-plugin'
});
