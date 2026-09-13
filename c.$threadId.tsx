import { createFileRoute } from "@tanstack/react-router";

import { ChatPage } from "@/components/chat/chat-page";

export const Route = createFileRoute("/c/$threadId")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Conversa · Vetor" },
      {
        name: "description",
        content: "Sua conversa com a IA do Vetor, com histórico salvo na sua conta.",
      },
      { property: "og:title", content: "Conversa · Vetor" },
      {
        property: "og:description",
        content: "Sua conversa com a IA do Vetor, com histórico salvo na sua conta.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ThreadRoute,
});

function ThreadRoute() {
  const { threadId } = Route.useParams();
  return <ChatPage threadId={threadId} />;
}
