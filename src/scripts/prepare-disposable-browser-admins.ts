/** Sets temporary passwords only in a named localhost disposable database for headed browser verification. */
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;
const password = process.env.DISPOSABLE_BROWSER_PASSWORD;
if (!databaseUrl || !password || password.length < 12) throw new Error('A local DATABASE_URL and 12+ character DISPOSABLE_BROWSER_PASSWORD are required.');
const parsedUrl = new URL(databaseUrl);
const databaseName = parsedUrl.pathname.replace(/^\//, '');
if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname.toLowerCase()) || !/^seating_(disposable|restore_test)_/i.test(databaseName)) {
  throw new Error('Browser credential preparation is restricted to a named local disposable database.');
}

const prisma = new PrismaClient();
try {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const emails = ['techadmin@shaktiman.com', 'superadmin@shaktiman.com', 'unit1.admin@shaktiman.com'];
  const results = [];
  for (const email of emails) {
    const updated = await prisma.adminUser.updateMany({ where: { email }, data: { passwordHash, isActive: true } });
    results.push({ email, updated: updated.count });
  }
  console.log(JSON.stringify({ databaseName, results, passwordLogged: false }, null, 2));
} finally {
  await prisma.$disconnect();
}
