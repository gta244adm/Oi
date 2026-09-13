import { createFileRoute } from "@tanstack/react-router";

import { ChatPage } from "@/components/chat/chat-page";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Vetor · Chat com IA em português" },
      {
        name: "description",
        content:
          "Converse com a IA do Vetor: gere imagens, busque na web, envie arquivos e mantenha todo o histórico salvo.",
      },
      { property: "og:title", content: "Vetor · Chat com IA em português" },
      {
        property: "og:description",
        content:
          "Converse com a IA do Vetor: gere imagens, busque na web e envie arquivos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => <ChatPage />,
});
