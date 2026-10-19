// M8 channels (migration 0050_channels_m8.sql; FR-110, ADR-097): the files of message-log entries.
// Telegram files themselves are thread attachments (`attachment`); an email mailbox's OAuth tokens
// and their state are vault entries of its credential group (`secret://channel/<id>/oauth…`),
// never rows. SQL migrations are authoritative; test/schema.test.ts checks them.
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { channelMessage } from './channels.ts';

/** A file of a message-log entry: received (inbound), or sent, withheld or failed (outbound). */
export const channelMessageFile = sqliteTable(
  'channel_message_file',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => channelMessage.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    status: text('status', { enum: ['received', 'sent', 'withheld', 'failed'] }).notNull(),
    name: text('name').notNull(),
    size: integer('size'),
    contentType: text('content_type'),
    attachmentId: text('attachment_id'),
    artifactId: text('artifact_id'),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('uq_channel_message_file').on(t.messageId, t.idx)],
);
