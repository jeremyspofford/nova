# @nova/storage

The Hub's SQLite database (ADR-002, ADR-083): one connection on Node's built-in `node:sqlite`,
serialized transactions, forward-only migrations in `migrations/` with a backup before every
upgrade (`docs/06` §5), restore-from-backup as the rollback path, and a Drizzle schema that a test
keeps in agreement with the SQL.
