import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';

export interface SessionPluginOptions {
  secret?: string;
  salt?: string | Buffer;
  cookieName?: string;
}

const sessionPlugin: FastifyPluginAsync<SessionPluginOptions> = async (fastify, options) => {
  // CRITICAL: @fastify/cookie must be registered before @fastify/secure-session
  await fastify.register(fastifyCookie);

  // In production, enforce strict secrets validation
  if (process.env.NODE_ENV === 'production') {
    const rawSecret = options.secret || process.env.SESSION_SECRET;
    if (!rawSecret || rawSecret.length < 32) {
      throw new Error(
        'FATAL: In production, SESSION_SECRET must be explicitly set and be at least 32 characters long.'
      );
    }
    const rawSalt = options.salt || process.env.SESSION_SALT;
    const saltLength = Buffer.isBuffer(rawSalt)
      ? rawSalt.length
      : typeof rawSalt === 'string'
      ? rawSalt.length
      : 0;
    if (!rawSalt || saltLength < 16) {
      throw new Error(
        'FATAL: In production, SESSION_SALT must be explicitly set and be at least 16 characters/bytes long.'
      );
    }
  }

  const secret = options.secret || process.env.SESSION_SECRET || 'a-very-long-32-byte-secret-key-for-fastify-session-security!!';

  let salt: Buffer | string;
  if (options.salt) {
    if (Buffer.isBuffer(options.salt)) {
      salt = options.salt;
    } else if (typeof options.salt === 'string' && options.salt.length === 24) {
      salt = Buffer.from(options.salt, 'base64');
    } else {
      salt = options.salt;
    }
  } else if (process.env.SESSION_SALT) {
    salt = process.env.SESSION_SALT.length === 24
      ? Buffer.from(process.env.SESSION_SALT, 'base64')
      : process.env.SESSION_SALT;
  } else {
    salt = Buffer.from('mq9hDxBVDbspDR6nLfFT1g==', 'base64');
  }

  const cookieName = options.cookieName || process.env.SESSION_COOKIE_NAME || 'sessionId';
  fastify.decorate('sessionCookieName', cookieName);

  await fastify.register(fastifySecureSession, {
    secret,
    salt,
    cookieName,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 86400 // 24 hours
    }
  });
};

export default fp(sessionPlugin, {
  name: 'session-plugin'
});
