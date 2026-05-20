import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { ChatProvider } from "./stores/chat-store";

export default function App() {
  return (
    <ChatProvider>
      <RouterProvider router={router} />
    </ChatProvider>
  );
}
