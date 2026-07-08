-- Normalize double-encoded audit payloads. The audit writers used to
-- json.dumps() before handing the value to asyncpg, whose pool-level jsonb
-- codec (db.py) dumps again — so every data/details value was stored as a
-- jsonb *string* containing JSON, unqueryable with -> / ->>. The writers now
-- pass dicts; this unwraps the historical rows to real objects.

UPDATE audit_log
   SET data = (data #>> '{}')::jsonb
 WHERE data IS NOT NULL AND jsonb_typeof(data) = 'string';

UPDATE rbac_audit_log
   SET details = (details #>> '{}')::jsonb
 WHERE details IS NOT NULL AND jsonb_typeof(details) = 'string';
