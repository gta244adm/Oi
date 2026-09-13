import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  tool,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { z } from "zod";

import {
  createDirectGoogleProvider,
  createDirectOpenAiProvider,
  createLovableChatProvider,
  createLovableResponsesProvider,
  generateGatewayImage,
  getLovableAiGatewayRunId,
  probeDirect,
  probeGateway,
} from "@/lib/ai-gateway.server";

const SIGNED_URL_TTL = 60 * 60 * 24 * 365;

const SYSTEM_PROMPT = `Você é o Vetor, um assistente de IA em português do Brasil.
Seja direto, claro e útil. Use markdown quando ajudar a leitura.
Você tem ferramentas:
- "gerar_imagem": use quando a pessoa pedir uma imagem, ilustração, logo, arte ou foto. Escreva o prompt em inglês, detalhado.
- "buscar_na_web": use quando precisar de informações atuais, notícias, preços, dados recentes ou fatos que você não tem certeza. Sempre cite as fontes depois.
Quando a pessoa enviar imagens ou arquivos, analise o conteúdo antes de responder.
Nunca invente fontes nem links.`;

function userClient(token: string): SupabaseClient {
  const url = process.env["SUPABASE_URL"]!;
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}`, apikey: key } },
  });
}

function textOf(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

async function searchWeb(query: string) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    },
    body: new URLSearchParams({ q: query, kl: "br-pt" }).toString(),
  });

  if (!res.ok) throw new Error(`Busca indisponível (${res.status}).`);
  const html = await res.text();

  const results: Array<{ titulo: string; url: string; resumo: string }> = [];
  const blockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|<\/body>)/g;

  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) && results.length < 6) {
    let href = decodeEntities(match[1] ?? "");
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]!);
    if (!href.startsWith("http")) continue;

    const snippetMatch = (match[3] ?? "").match(
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/,
    );
    results.push({
      titulo: stripTags(match[2] ?? "").slice(0, 200),
      url: href,
      resumo: stripTags(snippetMatch?.[1] ?? "").slice(0, 400),
    });
  }

  return results;
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.replace(/^Bearer\s+/i, "").trim();
        if (!token) return new Response("Não autenticado", { status: 401 });

        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) return new Response("LOVABLE_API_KEY ausente", { status: 500 });

        const supabase = userClient(token);
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        const user = userData?.user;
        if (userError || !user) return new Response("Não autenticado", { status: 401 });

        const body = (await request.json()) as {
          messages?: UIMessage[];
          threadId?: string;
        };
        const messages = body.messages;
        const threadId = body.threadId;
        if (!Array.isArray(messages) || !threadId) {
          return new Response("Requisição inválida", { status: 400 });
        }

        const { data: thread } = await supabase
          .from("threads")
          .select("id, title")
          .eq("id", threadId)
          .maybeSingle();
        if (!thread) return new Response("Conversa não encontrada", { status: 404 });

        // Persist the newest user message.
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "user") {
          const { error: insertError } = await supabase.from("messages").insert({
            thread_id: threadId,
            user_id: user.id,
            client_id: lastMessage.id,
            role: "user",
            parts: lastMessage.parts as unknown as object,
          });
          if (insertError) console.error("[chat] salvar mensagem do usuário", insertError);

          if (!thread.title || thread.title === "Nova conversa") {
            const title = textOf(lastMessage).slice(0, 60);
            if (title) {
              await supabase.from("threads").update({ title }).eq("id", threadId);
            }
          } else {
            await supabase
              .from("threads")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", threadId);
          }
        }

        const initialRunId = getLovableAiGatewayRunId(request);
        const { provider: gatewayResponses } = createLovableResponsesProvider(
          apiKey,
          initialRunId,
        );
        const { provider: gatewayChat } = createLovableChatProvider(apiKey, initialRunId);
        const ownOpenAiKey = process.env["OPENAI_API_KEY"];
        const ownGoogleKey =
          process.env["GOOGLE_API_KEY"] ?? process.env["GOOGLE_GENERATIVE_AI_API_KEY"];

        const tools = {
          gerar_imagem: tool({
            description:
              "Gera uma imagem a partir de uma descrição detalhada em inglês. Use para pedidos de imagem, ilustração, logo ou arte.",
            inputSchema: z.object({
              prompt: z
                .string()
                .describe("Descrição detalhada da imagem, em inglês."),
            }),
            execute: async ({ prompt }) => {
              const image = await generateGatewayImage(apiKey, prompt);
              const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0));
              const path = `${user.id}/gerado/${crypto.randomUUID()}.png`;
              const { error: uploadError } = await supabase.storage
                .from("chat-files")
                .upload(path, bytes, { contentType: image.mimeType, upsert: false });
              if (uploadError) throw new Error(uploadError.message);
              const { data: signed } = await supabase.storage
                .from("chat-files")
                .createSignedUrl(path, SIGNED_URL_TTL);
              return { url: signed?.signedUrl ?? "", prompt };
            },
          }),
          buscar_na_web: tool({
            description:
              "Busca informações atuais na web e retorna os principais resultados com título, link e resumo.",
            inputSchema: z.object({
              consulta: z.string().describe("Termos de busca."),
            }),
            execute: async ({ consulta }) => {
              const resultados = await searchWeb(consulta);
              return { consulta, resultados };
            },
          }),
        };

        const modelMessages = await convertToModelMessages(messages);

        // Fontes de IA em ordem de preferência: créditos da Lovable primeiro,
        // depois a chave própria do dono do app. Cada fonte é testada com uma
        // chamada mínima antes de transmitir, então falta de crédito, chave
        // inválida ou serviço fora do ar são detectados antes da resposta.
        type Attempt = { label: string; model: LanguageModel; reasoning: boolean };
        const attempts: Attempt[] = [];
        const notes: string[] = [];

        const gatewayStatus = await probeGateway(apiKey);
        if (gatewayStatus.state === "ok") {
          attempts.push({
            label: "openai/gpt-6-astra",
            model: gatewayResponses.responses("openai/gpt-6-astra"),
            reasoning: true,
          });
          for (const id of [
            "google/gemini-3.8-flash",
            "google/gemini-3.6-flash",
            "google/gemini-3.1-flash-lite",
          ]) {
            attempts.push({ label: id, model: gatewayChat(id), reasoning: false });
          }
        } else {
          notes.push(`Lovable AI: ${gatewayStatus.message}`);
        }

        if (ownOpenAiKey) {
          const status = await probeDirect("openai", ownOpenAiKey);
          if (status.state === "ok") {
            const direct = createDirectOpenAiProvider(ownOpenAiKey);
            for (const id of ["gpt-4o-mini", "gpt-4o"]) {
              attempts.push({ label: `openai:${id}`, model: direct(id), reasoning: false });
            }
          } else {
            notes.push(`Chave OpenAI: ${status.message}`);
          }
        }

        if (ownGoogleKey) {
          const status = await probeDirect("google", ownGoogleKey);
          if (status.state === "ok") {
            const direct = createDirectGoogleProvider(ownGoogleKey);
            for (const id of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
              attempts.push({ label: `google:${id}`, model: direct(id), reasoning: false });
            }
          } else {
            notes.push(`Chave Google: ${status.message}`);
          }
        }

        if (attempts.length === 0) {
          const hasOwnKey = Boolean(ownOpenAiKey || ownGoogleKey);
          const advice = hasOwnKey
            ? "Confira se a sua chave de IA é válida e tem saldo."
            : "Adicione créditos de IA na Lovable ou configure uma chave própria (OpenAI ou Google) para continuar usando sem limite de créditos.";
          const blocked = notes.some((note) => note.includes("crédito") || note.includes("bloq"));
          return new Response(`${notes.join(" · ") || "IA indisponível."} ${advice}`, {
            status: blocked ? 402 : 503,
          });
        }

        const chosen = attempts[0]!;
        const fallbacks = attempts.slice(1).map((attempt) => attempt.label);
        const result = streamText({
          model: chosen.model,
          system: SYSTEM_PROMPT,
          messages: modelMessages,
          tools,
          stopWhen: stepCountIs(50),
          abortSignal: request.signal,
          ...(chosen.reasoning
            ? {
                providerOptions: {
                  openai: {
                    forceReasoning: true,
                    reasoningEffort: "medium",
                    reasoningSummary: "auto",
                    store: false,
                    include: ["reasoning.encrypted_content"],
                  },
                },
              }
            : {}),
          onError: ({ error }) => {
            console.error(
              `[chat] erro de streaming (${chosen.label}); alternativas: ${fallbacks.join(", ") || "nenhuma"}`,
              error,
            );
          },
        });



        return result.toUIMessageStreamResponse({
          originalMessages: messages,
          sendReasoning: true,
          onFinish: async ({ responseMessage }) => {
            if (!responseMessage) return;
            const { error } = await supabase.from("messages").insert({
              thread_id: threadId,
              user_id: user.id,
              client_id: responseMessage.id,
              role: "assistant",
              parts: responseMessage.parts as unknown as object,
            });
            if (error) console.error("[chat] salvar resposta", error);
            await supabase
              .from("threads")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", threadId);
          },
        });
      },
    },
  },
});
