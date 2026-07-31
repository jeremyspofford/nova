-- deployer: say that a manifest cannot choose its pods' identity.
--
-- workloads.apply now refuses any document naming a ServiceAccount — either
-- spelling — and applies every pod spec with the token switched off. That is
-- the control; this is only the sentence, and it exists because a refusal the
-- agent did not see coming costs a round trip every time.
--
-- The rest of that bullet list describes what Pod Security enforces. This one
-- is different in kind and the prompt does not say so, deliberately: from
-- where she stands the namespace refuses it either way, and which component
-- did the refusing is not a fact she can act on. `workloads.py` carries that
-- distinction, for the human reading it.
--
-- Measured before the fix, 2026-07-31: a Pod naming serviceAccountName
-- nova-deployer was admitted by the API server (HTTP 201), ran, and mounted a
-- valid 1204-byte token for the account this backend itself uses. Pod
-- Security governs what a container may do, never whose token it holds.
--
-- deployer is the only agent holding deploy_workload, so this is the only
-- prompt that needs it.

UPDATE agents SET system_prompt = replace(
    system_prompt,
    '- no privileged containers, no host network or PID, no hostPath volumes, no NodePort or LoadBalancer services',
    '- no privileged containers, no host network or PID, no hostPath volumes, no NodePort or LoadBalancer services
- never set serviceAccountName (or automountServiceAccountToken) on anything. Naming an account is refused and NOTHING in that submission is applied, not even the documents that were fine. Pods run as `default` with no API token mounted, which is what a service you deploy should need; if one genuinely must reach the Kubernetes API, say so and stop — that is the operator''s decision to make in the cluster, not a line you can write'),
    updated_at = now()
 WHERE name = 'deployer'
   AND system_prompt LIKE '%no NodePort or LoadBalancer services%'
   AND system_prompt NOT LIKE '%never set serviceAccountName%';
