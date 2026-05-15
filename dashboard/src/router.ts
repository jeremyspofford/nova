import {
  createRouter,
  createRoute,
  createRootRoute,
} from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Chat } from "./pages/chat/ChatPage";
import { Tasks } from "./pages/Tasks";
import { Memory } from "./pages/Memory";
import { Schedules } from "./pages/Schedules";
import { Settings } from "./pages/Settings";

const rootRoute = createRootRoute({ component: Layout });
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Chat });
const tasksRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tasks", component: Tasks });
const memoryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/memory", component: Memory });
const schedulesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/schedules", component: Schedules });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: Settings });

const routeTree = rootRoute.addChildren([
  chatRoute,
  tasksRoute,
  memoryRoute,
  schedulesRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
