console.error(
  'Prisma Migrate is not supported for MongoDB. No schema operation was run. Use db:validate for schema checks; production schema changes require an approved, separately reviewed MongoDB procedure.',
);
process.exit(1);
