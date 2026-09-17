-- The nine device tools join the action-class table (slice 5, T2). The kernel
-- (app/policy.py) DENIES a tool with no row here (fail-closed), and the "every
-- registered tool has a row" tripwire (tests/test_action_classes.py) reddens the
-- day a registered tool lands without one — so these rows are REQUIRED, not
-- optional, and this is their deliberate arrival.
--
-- Dispositions follow slice 5's Architecture and rd6's owner directive (reads
-- never gate; the gate that remains is exactly the irreversible set):
--   auto     the six reads/harmless effects. A device_notify is a visible effect
--            but reversible and harmless, so it joins the reads.
--   consent  the three that change a machine or run code on it — device_run
--            (shell.exec), device_write_file (fs.write), device_launch_app
--            (apps.launch). These graduate via S3 earned autonomy exactly like
--            any consent class; nothing here is a new authorizer.
--
-- risk_tier is descriptive only (audit/UI) — the kernel reads disposition. All
-- nine carry 'device' so Settings -> Autonomy can group them. earned stays at
-- its default false: these are owner-set seeds, NOT graduated autos, so a single
-- failure must never demote a seeded row (policy only tracks earned autos).
--
-- ON CONFLICT DO NOTHING, for the same reason migration 009 chose it: an
-- operator who later revokes device_run to 'consent' (or tightens a read) in
-- Settings -> Autonomy must never be quietly overwritten back on re-apply.
INSERT INTO action_classes (action_class, risk_tier, disposition) VALUES
    ('device_list',        'device', 'auto'),
    ('device_info',        'device', 'auto'),
    ('device_list_files',  'device', 'auto'),
    ('device_read_file',   'device', 'auto'),
    ('device_list_apps',   'device', 'auto'),
    ('device_notify',      'device', 'auto'),
    ('device_run',         'device', 'consent'),
    ('device_write_file',  'device', 'consent'),
    ('device_launch_app',  'device', 'consent')
ON CONFLICT (action_class) DO NOTHING;
