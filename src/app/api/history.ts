import { env } from "cloudflare:workers";
import type { RequestInfo } from "rwsdk/worker";

interface Conversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface DBMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
}

function db(): D1Database {
  return (env as unknown as Env).DB;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export async function listConversations(): Promise<Response> {
  try {
    const { results } = await db()
      .prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200")
      .all<Conversation>();
    return Response.json({ conversations: results ?? [] });
  } catch {
    return Response.json({ conversations: [] });
  }
}

export async function saveConversation({ request }: RequestInfo): Promise<Response> {
  const body = (await request.json()) as {
    conversationId?: string;
    title?: string;
    messages: { role: string; content: string }[];
  };

  const d = db();
  let now = Date.now();
  let convId = body.conversationId ?? null;
  if (!convId) convId = genId();

  const title = (body.title ?? "Nueva conversación").slice(0, 100);
  // UPSERT: create the conversation if it doesn't exist, otherwise only bump updated_at
  await d
    .prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .bind(convId, title, now, now)
    .run();

  for (const msg of body.messages) {
    await d
      .prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(genId(), convId, msg.role, msg.content, now++)
      .run();
  }

  return Response.json({ conversationId: convId });
}

export async function getConversation({ params }: RequestInfo): Promise<Response> {
  const { id } = params as { id: string };
  const d = db();

  const conversation = await d
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .bind(id)
    .first<Conversation>();

  if (!conversation) return new Response(null, { status: 404 });

  const { results: messages } = await d
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
    .bind(id)
    .all<DBMessage>();

  return Response.json({ conversation, messages: messages ?? [] });
}

export async function deleteConversation({ params }: RequestInfo): Promise<Response> {
  const { id } = params as { id: string };
  await db().prepare("DELETE FROM conversations WHERE id = ?").bind(id).run();
  return Response.json({ success: true });
}
