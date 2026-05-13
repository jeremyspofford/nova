import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { ConversationProvider } from "./contexts/ConversationContext";

export default function App() {
  return (
    <ConversationProvider>
      <RouterProvider router={router} />
    </ConversationProvider>
  );
}
