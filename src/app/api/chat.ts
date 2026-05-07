import { env } from "cloudflare:workers";

interface GroqMessage {
  role: string;
  content: string | object[];
}

interface ChatRequest {
  messages: GroqMessage[];
  model: string;
  temperature: number;
  maxTokens: number;
}

export async function chatHandler({ request }: { request: Request }): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const { messages, model, temperature, maxTokens } = body;

  const groqKey = (env as unknown as Record<string, string>).GROQ_API_KEY;
  if (!groqKey) {
    return Response.json({ error: { message: "GROQ_API_KEY no configurada" } }, { status: 500 });
  }

  const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqKey}`,
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });

  const data = await upstream.json();
  return Response.json(data, { status: upstream.status });
}
