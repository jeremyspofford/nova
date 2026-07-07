import { useLayoutEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, LineChart } from 'lucide-react'
import { useAuth } from '../stores/auth-store'
import { PageHeader } from '../components/layout/PageHeader'
import { Button, Card, Code } from '../components/ui'

const BOARDS = [
  { uid: 'nova-autonomy', label: 'Autonomy' },
  { uid: 'nova-operations', label: 'Operations' },
] as const

type BoardUid = (typeof BOARDS)[number]['uid']

/**
 * Grafana embedded through the dashboard's own origin (/grafana nginx proxy),
 * authenticated with the operator's OWN Nova session: the iframe URL carries
 * the current JWT (?auth_token=), which Grafana validates against Nova's
 * signing key (JWKS from `make observability`). Same account, no second
 * login. Grafana then holds its own session cookie, so the 15-minute token
 * lifetime doesn't interrupt viewing.
 */
export function Monitoring() {
  const { accessToken } = useAuth()
  const [board, setBoard] = useState<BoardUid>('nova-autonomy')

  // Hand the session to Grafana via a same-origin cookie scoped to /grafana —
  // nginx injects it as the JWT header on every proxied request. ORDERING
  // MATTERS: the iframe fires its request at commit, before passive effects
  // run — writing the cookie in useEffect loses that race and Grafana's
  // first load 401s onto its login page. So: layout effect (runs before
  // paint) + gate the iframe on cookieReady. Re-stamped every minute so the
  // cookie never outlives the token; cleared on leave.
  const [cookieReady, setCookieReady] = useState(false)
  useLayoutEffect(() => {
    if (!accessToken) return
    const stamp = () => {
      document.cookie = `nova_grafana_jwt=${accessToken}; path=/grafana; max-age=900; SameSite=Strict`
    }
    stamp()
    setCookieReady(true)
    const interval = setInterval(stamp, 60_000)
    return () => {
      clearInterval(interval)
      setCookieReady(false)
      document.cookie = 'nova_grafana_jwt=; path=/grafana; max-age=0; SameSite=Strict'
    }
  }, [accessToken])

  const { data: grafanaUp, isLoading: probing } = useQuery({
    queryKey: ['grafana-health'],
    queryFn: async () => {
      const r = await fetch('/grafana/api/health')
      return r.ok
    },
    refetchInterval: 30_000,
    retry: 0,
  })

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <PageHeader
        title="Monitoring"
        description="Nova's autonomy and operations dashboards, live from its own database"
        actions={
          <div className="flex items-center gap-2">
            {BOARDS.map(b => (
              <Button
                key={b.uid}
                size="sm"
                variant={board === b.uid ? 'primary' : 'ghost'}
                onClick={() => setBoard(b.uid)}
              >
                {b.label}
              </Button>
            ))}
            <a href={`/grafana/d/${board}`} target="_blank" rel="noreferrer">
              <Button size="sm" variant="outline" icon={<ExternalLink size={14} />}>
                Open in Grafana
              </Button>
            </a>
          </div>
        }
      />

      {probing ? null : grafanaUp === false || grafanaUp === undefined ? (
        <Card className="p-8 text-center">
          <LineChart className="mx-auto h-8 w-8 text-content-tertiary" />
          <p className="mt-3 text-compact font-medium text-content-primary">
            The observability profile isn't running
          </p>
          <p className="mx-auto mt-1 max-w-md text-caption text-content-tertiary">
            Start Grafana (it also refreshes the shared signing key) and this page
            will pick it up within 30 seconds:
          </p>
          <div className="mx-auto mt-3 max-w-xs">
            <Code>make observability</Code>
          </div>
        </Card>
      ) : !accessToken ? (
        <Card className="p-8 text-center">
          <LineChart className="mx-auto h-8 w-8 text-content-tertiary" />
          <p className="mt-3 text-compact font-medium text-content-primary">
            Sign in to view embedded dashboards
          </p>
          <p className="mx-auto mt-1 max-w-md text-caption text-content-tertiary">
            The embedded boards authenticate with your Nova account session.
            Ambient access (trusted network / break-glass) has no session token
            to hand to Grafana — sign in at /login, or open Grafana directly at{' '}
            <span className="font-mono">localhost:3001</span>.
          </p>
        </Card>
      ) : !cookieReady ? null : (
        <iframe
          key={board}
          title={`Nova ${board}`}
          src={`/grafana/d/${board}?kiosk`}
          className="w-full flex-1 rounded-lg border border-border-subtle bg-surface-card"
        />
      )}
    </div>
  )
}
