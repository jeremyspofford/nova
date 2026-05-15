import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { ConversationProvider } from "./contexts/ConversationContext";
import { ChatProvider } from "./stores/chat-store";

export default function App() {
  return (
    <ConversationProvider>
      <ChatProvider>
        <RouterProvider router={router} />
      </ChatProvider>
    </ConversationProvider>
  );
}
