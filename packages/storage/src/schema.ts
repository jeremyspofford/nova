// Drizzle table definitions, one file per domain under schema/. They mirror the SQL in
// migrations/; the SQL is authoritative and test/schema.test.ts checks that both agree.
// Add a domain by creating schema/<domain>.ts and one export line here.
export * from './schema/core.ts';
export * from './schema/chat.ts';
export * from './schema/conversation.ts';
export * from './schema/nodes.ts';
export * from './schema/tools.ts';
export * from './schema/policy.ts';
export * from './schema/mcp.ts';
export * from './schema/ops.ts';
export * from './schema/consolidation.ts';
export * from './schema/plugins.ts';
export * from './schema/hooks.ts';
export * from './schema/apps.ts';
export * from './schema/workspace.ts';
export * from './schema/profile.ts';
