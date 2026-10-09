-- `local` derived from the base_url host (local-context epic T2). Until now a
-- non-engine row was local only when the owner said so, so a row saved before
-- the gateway read the host — the Dell, at a tailnet address — carries the old
-- default false and every call on it was priced and capped as cloud.
--
-- The one-time backfill states providers.local_by_host in SQL: loopback
-- (127/8, ::1), localhost, RFC1918 (10/8, 172.16/12, 192.168/16), the 100.64/10
-- tailnet range, and any *.ts.net name. It only ever sets true — a public row
-- keeps whatever it holds (an owner's true stays true). A stored false on a
-- private host cannot be told apart from the old default, so it reads local.
--
-- The host is parsed here, not cast blindly: strip the scheme, the path, any
-- userinfo, then an [ipv6] bracket or a :port. A named host never reaches the
-- inet cast, and a cast that still fails reads as not local rather than
-- aborting the migration.
DO $$
DECLARE
    r record;
    authority text;
    host text;
    address inet;
BEGIN
    FOR r IN SELECT name, base_url FROM providers WHERE NOT local AND base_url IS NOT NULL LOOP
        authority := regexp_replace(lower(btrim(r.base_url)), '^[a-z][a-z0-9+.-]*://', '');
        authority := split_part(split_part(split_part(authority, '/', 1), '?', 1), '#', 1);
        authority := regexp_replace(authority, '^.*@', '');
        IF authority LIKE '[%' THEN
            host := substring(authority FROM '^\[([^]]*)\]');
        ELSE
            host := split_part(authority, ':', 1);
        END IF;
        host := rtrim(coalesce(host, ''), '.');
        CONTINUE WHEN host = '';
        IF host = 'localhost' OR host LIKE '%.ts.net' THEN
            UPDATE providers SET local = true, updated_at = now() WHERE name = r.name;
            CONTINUE;
        END IF;
        CONTINUE WHEN host !~ '^[0-9a-f:.]+$';
        BEGIN
            address := host::inet;
        EXCEPTION WHEN others THEN
            CONTINUE;
        END;
        IF address <<= inet '127.0.0.0/8'
            OR address = inet '::1'
            OR address <<= inet '10.0.0.0/8'
            OR address <<= inet '172.16.0.0/12'
            OR address <<= inet '192.168.0.0/16'
            OR address <<= inet '100.64.0.0/10' THEN
            UPDATE providers SET local = true, updated_at = now() WHERE name = r.name;
        END IF;
    END LOOP;
END
$$;
