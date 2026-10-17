# @nova/policy

The policy engine (FR-099, `docs/12` §2): a pure, deterministic `evaluate(context, policies)` that
returns allow / ask / handoff / deny with a reason, layer, rule id and confirmation tier.
Built-in safety (hard denies, confirmation tiers, intent provenance, FR-189) sets a floor that no
rule can relax; any matching deny wins; allowed consequential agent actions are flagged for the
auto-reviewer (FR-085). 90 % branch coverage floor.
