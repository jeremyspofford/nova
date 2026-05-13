import { useServiceHealth, deriveStatus } from "../hooks/useServiceHealth";

const COLORS: Record<string, string> = {
  ok:       "bg-emerald-500",
  degraded: "bg-amber-400",
  critical: "bg-red-500",
};

export function ServiceStatusDot() {
  const { data } = useServiceHealth();
  const status = data ? deriveStatus(data) : "ok";
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${COLORS[status]}`}
      title={`Services: ${status}`}
    />
  );
}
