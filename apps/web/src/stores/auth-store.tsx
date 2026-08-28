// Minimal stub — Task 6 wires real auth. Exposes just enough shape for
// Sidebar/MobileNav to render a signed-in state; hardcodes a dev owner
// so every minRole check passes (owner is the top of the role hierarchy).
export interface AuthUser {
  name: string
  role: 'owner'
}

const DEV_OWNER: AuthUser = { name: 'Dev Owner', role: 'owner' }

export function useAuth(): { user: AuthUser | null } {
  return { user: DEV_OWNER }
}
