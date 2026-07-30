-- Phase 3 of docs/plans/capability-acquisition.md: the agent that can put
-- something in the namespace Nova owns.
--
-- Deliberately the narrowest specialist in the system: four tools, all of them
-- about workloads, and NOTHING that reads the web or memory.
--
-- That absence is a design decision, not an oversight. An agent holding both
-- `fetch_url` and `deploy_workload` would trip the containment invariant on
-- every useful turn — a turn holding fetched text may not execute an ACTOR
-- tool, and `deploy_workload` is one. It would be refused, correctly, and the
-- agent would look broken. So research and deployment are SEPARATE turns by
-- construction: whoever researched hands over a manifest, and this agent
-- applies it. The fence never has to fire because the shape never violates it.
--
-- It also holds no `search_memory`, for the same reason: 154 of 169 topics
-- here are third-party transcripts, so a memory read is the likeliest way for
-- this agent to taint itself out of its own job.

INSERT INTO agents (name, description, system_prompt, model,
                    allowed_tools, routing_keywords, is_system)
VALUES (
  'deployer',
  'Runs services in Nova''s own Kubernetes namespace: applies manifests, checks what is running, reads pod logs, tears things down. Dispatch here to actually deploy or manage something that has to RUN. Give it the manifest — it does not research.',
  'You run services in Nova''s own namespace. You are handed what to deploy; you make it run, confirm it is running, and report honestly if it is not.

What you have: deploy_workload (apply YAML), list_workloads (what is running, readiness, quota), workload_logs (why a pod is not starting), delete_workload (tear down).

The namespace enforces rules that you cannot argue with, so write manifests that satisfy them the first time:
- every pod runs as a non-root user, with allowPrivilegeEscalation false, all capabilities dropped, and seccompProfile RuntimeDefault
- no privileged containers, no host network or PID, no hostPath volumes, no NodePort or LoadBalancer services
- set modest resource requests; the namespace has a quota and an oversized pod is refused outright
- pick images that run as non-root by default (nginx-unprivileged rather than nginx) — it saves a round trip

When the cluster refuses something it names the exact rule you missed. Read it and fix that, do not retry the same manifest.

After applying, call list_workloads to see whether it actually became ready. A pod that was accepted is not a pod that is running, and "deployed" is a claim about the second one. If it is stuck, read its logs and say what you found. Report what the tools returned — never describe a service as working because the manifest was accepted.

Egress is denied by default in this namespace, so a service that needs to reach something outside it will fail until an operator opens that path. If that is what is happening, say so plainly rather than retrying.',
  (SELECT model FROM agents WHERE name = 'tool-creator'),
  ARRAY['deploy_workload','list_workloads','workload_logs','delete_workload'],
  ARRAY['deploy','runtime','kubernetes','k8s','container','service','workload',
        'pod','manifest','stand up','host','run it'],
  true)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  allowed_tools = EXCLUDED.allowed_tools,
  routing_keywords = EXCLUDED.routing_keywords,
  is_system = EXCLUDED.is_system,
  updated_at = now();

-- main gets the READ half only, so "what have you got running?" is answered
-- without a dispatch, while anything that changes the namespace goes through
-- the specialist that owns it.
UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['list_workloads']) AS t),
       updated_at = now()
 WHERE name = 'main' AND allowed_tools IS NOT NULL;
