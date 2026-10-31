Owner decisions, 2026-10-31, on docs/plans/M10-orchestration.md. Verbatim below.

---

Owner decisions on the M10 orchestration ADR
(docs/plans/M10-orchestration.md). All six proposed resolutions are
APPROVED as written. Record them in the ADR as decided (not
"proposed"), resolve the matching Packet-conflicts rows and Open
questions, and proceed with the M10e–M10k phase order as designed.

1. Native workloads (Conflicts row 2 / Open question 1): the BOOT
   agent gains a fixed verb set (install a verified artifact, start,
   stop, switch, probe health on loopback) for hub-signed workloads
   only — no arbitrary execution. The runtime agent decides and
   reports; it still cannot start processes.
2. Hub identity (rows 4–5 / Open question 2): the roster's lineage
   and the stable mesh name are what transfer at promotion; private
   keys NEVER move. The roster pins every hub candidate's key (each
   candidacy itself Tier-3 approved), so a cold promotion needs no
   re-pairing. Epochs only rise; a promotion roll-back is epoch + 2.
3. Topology graph (row 6 / Open question 3): hand-drawn SVG with
   drill-in, NO new runtime dependency. Vendoring a graph library is
   a future decision only if the map demonstrably outgrows this.
4. Capture pilot (row 3 / Open question 4): Screenpipe as a managed
   native workload first (deployed/supervised/versioned by Nova,
   under Screenpipe's own code signature). A Nova-built capture
   component comes later under ADR-2; signing identities remain the
   owner's separate call.
5. Secrets after emergency promotion (Open question 5): NO vault-key
   escrow. Backups never contain keys. After a cold promotion from
   backup, connectors are signed in again, and the promotion sheet
   says so plainly, with the backup's time and what was lost.
6. GitOps repository (row 7 / Open question 6): a SEPARATE services
   repository in the home (services.git), written only by the change
   pipeline's promote stage; Flux reads it with a per-cluster
   read-only deploy key from the vault. Rollback is a git revert made
   by the pipeline — never a manual helm rollback.
