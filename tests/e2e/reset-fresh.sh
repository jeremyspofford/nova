#!/usr/bin/env bash
# Put THIS stack back to first-run state so the wizard walk can be repeated.
#
# Scenario 1 mints the instance's one and only owner (core closes registration
# after the first), so it can only run against a fresh instance. On a machine
# where the v4 volumes do not exist yet, `./deploy/install.sh` already gives
# you that and you do not need this script at all.
#
# WHAT THIS TOUCHES: the three v4 databases (nova_core, nova_gateway,
# nova_memory) and the v4 memory files. Nothing else. It deliberately does NOT
# remove docker volumes — `docker compose down -v` and `docker volume rm` are
# forbidden on this box, because the legacy v3 stack shares the daemon and a
# mistyped volume name is unrecoverable. Dropping and recreating the databases
# inside the running postgres gets to the same fresh state without ever naming
# a volume.
#
#   tests/e2e/reset-fresh.sh          asks first
#   tests/e2e/reset-fresh.sh --yes    does not
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="docker compose -f $REPO_ROOT/deploy/docker-compose.yml"
INIT_SQL="$REPO_ROOT/deploy/postgres-init/01-databases.sql"

if [ "${1:-}" != "--yes" ]; then
  echo "This DELETES every account, conversation, trace, setting and memory file"
  echo "in the Nova v4 stack at $REPO_ROOT."
  printf 'Type "reset" to continue: '
  read -r answer
  [ "$answer" = "reset" ] || { echo "aborted"; exit 1; }
fi

# The services have to be down while their databases are dropped: an open
# connection blocks DROP DATABASE, and a running service would immediately
# re-run migrations into the half-made state.
echo "stopping core, gateway and memory…"
$COMPOSE stop core gateway memory

echo "dropping and recreating the three databases…"
$COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
-- Stopping the containers is not the same as postgres noticing. A backend
-- whose client vanished can sit in the list long enough to make DROP DATABASE
-- fail with "is being accessed by other users", which is how this script
-- exited 3 on its second use. Evict them by name first, then drop.
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN ('nova_core', 'nova_gateway', 'nova_memory')
  AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS nova_core WITH (FORCE);
DROP DATABASE IF EXISTS nova_gateway WITH (FORCE);
DROP DATABASE IF EXISTS nova_memory WITH (FORCE);
DROP ROLE IF EXISTS core;
DROP ROLE IF EXISTS gateway;
DROP ROLE IF EXISTS memory;
SQL
# The same file the postgres image runs on a fresh volume — one definition of
# what the databases and roles are, used both times.
$COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$INIT_SQL"

echo "clearing the memory store…"
$COMPOSE run --rm --no-deps --entrypoint sh memory -c 'rm -rf /data/memory/people && mkdir -p /data/memory'

# Back up through the installer, not a bare `up -d`: the installer is the one
# place that knows whether this host gets the GPU override, and re-running it
# here means a reset can never quietly bring ollama back on the CPU.
echo "starting the services again (via ./install)…"
"$REPO_ROOT/install"

echo
echo "Fresh. The installed ollama models are deliberately kept — re-pulling"
echo "gigabytes to re-walk the wizard proves nothing the first pull did not."
echo "Run the suite: cd tests/e2e && npm run e2e"
