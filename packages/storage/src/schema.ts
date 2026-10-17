// Drizzle table definitions, one file per domain under schema/. They mirror the SQL in
// migrations/; the SQL is authoritative and test/schema.test.ts checks that both agree.
// Add a domain by creating schema/<domain>.ts and one export line here.
export * from './schema/core.ts';
export * from './schema/chat.ts';
export * from './schema/conversation.ts';
export * from './schema/nodes.ts';
