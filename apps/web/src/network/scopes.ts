// The agents, Work runs and Code sessions a network rule or a credential can belong to (docs/11
// §7), with their names, so rules and log entries read "Agent: Research" instead of an id. Each
// list loads on its own; one that cannot load leaves its ids unnamed.
import { useCallback, useEffect, useState } from 'react';
import { useServices } from '../services.tsx';
import { useComputersApi } from '../computers/api.ts';
import { scopeKindText } from '../computers/format.ts';

/** The scopes the proxy applies to a command (an agent, its run, a Code session). */
export const RULE_SCOPES = ['agent', 'run', 'session'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export interface ScopeOption {
  id: string;
  name: string;
}

export type ScopeTargets = Record<RuleScope, ScopeOption[] | null>;

export function isRuleScope(kind: string): kind is RuleScope {
  return (RULE_SCOPES as readonly string[]).includes(kind);
}

export function useScopeTargets(): {
  targets: ScopeTargets;
  /** "Agent: Research", or the kind and a short id when the name is not known. */
  label: (kind: string, id: string) => string;
} {
  const { api } = useServices();
  const computers = useComputersApi();
  const [targets, setTargets] = useState<ScopeTargets>({ agent: null, run: null, session: null });

  useEffect(() => {
    let alive = true;
    const put = (kind: RuleScope, list: ScopeOption[]) => {
      if (alive) setTargets((t) => ({ ...t, [kind]: list }));
    };
    computers.listComputerAgents().then(
      ({ items }) =>
        put(
          'agent',
          items.map((a) => ({ id: a.id, name: a.name })),
        ),
      () => put('agent', []),
    );
    api.listRuns({ status: 'all' }).then(
      ({ items }) =>
        put(
          'run',
          items.map((r) => ({ id: r.id, name: r.title })),
        ),
      () => put('run', []),
    );
    api.listCodeSessions().then(
      ({ items }) =>
        put(
          'session',
          items.map((s) => ({ id: s.id, name: s.title ?? s.folder.path })),
        ),
      () => put('session', []),
    );
    return () => {
      alive = false;
    };
  }, [api, computers]);

  const label = useCallback(
    (kind: string, id: string) => {
      if (kind === 'sandbox') return 'A sandbox';
      const name = isRuleScope(kind) ? targets[kind]?.find((o) => o.id === id)?.name : undefined;
      return `${scopeKindText(kind)}: ${name ?? id.slice(0, 8)}`;
    },
    [targets],
  );

  return { targets, label };
}
