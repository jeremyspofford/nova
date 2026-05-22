"""Single source of truth for audit tunables. Env-overridable."""
from __future__ import annotations
import os

READ_DEADLINE_S = int(os.getenv("AUDIT_READ_DEADLINE_S", "90"))
MUTATE_DEADLINE_S = int(os.getenv("AUDIT_MUTATE_DEADLINE_S", "120"))
PER_MODEL_BUDGET_S = int(os.getenv("AUDIT_PER_MODEL_BUDGET_S", "300"))  # 5 min
TRIALS_PER_PROBE = int(os.getenv("AUDIT_TRIALS", "3"))

RUN_ID_PREFIX_TEMPLATE = "nova-audit-{run_id}-"

OUTPUT_DIR_TEMPLATE = "docs/audits/{date}-tool-use-audit"
OUTPUT_MD_TEMPLATE = "docs/audits/{date}-tool-use-audit.md"
