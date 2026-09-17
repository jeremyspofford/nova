#!/usr/bin/env bash
# WHERE DID SHE GET THAT? — the probe, as a command.
#
#   tools/where-did-that-come-from.sh "the model catalog could not be read"
#
# A sentence in a reply comes from one of three places, and only one of them
# is the turn you are looking at:
#
#   1. THIS TURN'S FACTS   — something core put in the prompt;
#   2. THE TRANSCRIPT      — she is repeating herself from earlier in the
#                            conversation;
#   3. RECALLED MEMORY     — a note, which is NOT per-conversation, so a
#                            fresh conversation proves nothing about it.
#
# On 2026-09-16 I called a case (2) and it was (3): a false sentence written
# into her journal while a bug was live came back on every later turn, and a
# cleared conversation said it again. The wrong answer was plausible, fast,
# and cost an afternoon. This asks all three.
set -u
PHRASE="${1:-}"
if [ -z "$PHRASE" ]; then
  echo "usage: $0 \"a phrase from her reply\"" >&2
  exit 2
fi
PG="docker exec nova-postgres-1 psql -U postgres -d nova_core -tAc"

echo "== 1. THE TRANSCRIPT — has she said this before? =="
$PG "SELECT to_char(created_at,'MM-DD HH24:MI') || '  ' || role || '  ' ||
     left(regexp_replace(content, '\s+', ' ', 'g'), 100)
     FROM messages WHERE content ILIKE '%$PHRASE%'
     ORDER BY created_at DESC LIMIT 5" 2>/dev/null | sed 's/^/  /'
echo

echo "== 2. RECALLED MEMORY — which notes did recent turns pull in? =="
# The span names them since 2026-09-16 (chat.recalled_sources). Before that
# it recorded only a count, which is what made this question expensive.
$PG "SELECT DISTINCT jsonb_array_elements_text(meta->'recalled')
     FROM turn_spans WHERE kind='memory_recall' AND meta ? 'recalled'
     ORDER BY 1 LIMIT 12" 2>/dev/null | sed 's/^/  /'
echo

echo "== 3. THE NOTES THEMSELVES — does the phrase live in memory? =="
docker exec nova-memory-1 sh -c "grep -rl '$PHRASE' /data/memory 2>/dev/null | head -5" \
  | sed 's|/data/memory/|  |'
echo
echo "A hit in 3 means clearing the conversation will NOT stop her saying it."
