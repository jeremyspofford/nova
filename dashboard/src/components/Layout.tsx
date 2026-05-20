import { useEffect } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import { MessageSquare, ListTodo, Brain, CalendarClock, Settings } from "lucide-react";
import { ServiceStatusDot } from "./ServiceStatusDot";

function useBootstrap() {
  useEffect(() => {
    fetch("/api/v1/auth/providers")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.trusted_network && data?.admin_secret) {
          localStorage.setItem("adminSecret", data.admin_secret);
        }
      })
      .catch(() => {});
  }, []);
}

const NAV = [
  { to: "/",          icon: MessageSquare, label: "Chat" },
  { to: "/tasks",     icon: ListTodo,      label: "Tasks" },
  { to: "/memory",    icon: Brain,         label: "Memory" },
  { to: "/schedules", icon: CalendarClock, label: "Schedules" },
  { to: "/settings",  icon: Settings,      label: "Settings" },
] as const;

export function Layout() {
  useBootstrap();
  return (
    <div className="flex h-screen bg-stone-950 text-stone-100">
      {/* Sidebar — hidden on mobile */}
      <nav className="hidden md:flex flex-col w-48 border-r border-stone-800 p-3 gap-1 shrink-0">
        <div className="flex items-center justify-between px-2 py-3 mb-2">
          <span className="text-lg font-semibold tracking-tight">Nova</span>
          <ServiceStatusDot />
        </div>
        {NAV.map(({ to, icon: Icon, label }) => (
          <Link
            key={to}
            to={to}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            activeProps={{ className: "bg-stone-800 text-stone-50" }}
            inactiveProps={{ className: "text-stone-400 hover:text-stone-200 hover:bg-stone-800/60" }}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>

      {/* Bottom nav — mobile only */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 border-t border-stone-800 bg-stone-950 flex">
        {NAV.slice(0, 4).map(({ to, icon: Icon, label }) => (
          <Link
            key={to}
            to={to}
            className="flex-1 flex flex-col items-center py-2 gap-0.5 text-xs"
            activeProps={{ className: "text-teal-400" }}
            inactiveProps={{ className: "text-stone-500" }}
          >
            <Icon size={20} />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
