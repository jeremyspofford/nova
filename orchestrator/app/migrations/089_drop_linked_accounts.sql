-- 089_drop_linked_accounts.sql
-- chat-bridge (Telegram/Slack relay) was removed; linked_accounts existed
-- solely to map bridge platform identities onto Nova users. Also purge the
-- bridge tokens that first-boot bootstrap may have mirrored into
-- platform_secrets.

DROP TABLE IF EXISTS linked_accounts;

DELETE FROM platform_secrets
WHERE key IN ('TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN');
