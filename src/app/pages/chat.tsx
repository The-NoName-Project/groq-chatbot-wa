"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import styles from "./chat.module.css";

declare var pdfjsLib: {
  getDocument: (opts: { data: ArrayBuffer }) => { promise: Promise<PdfDoc> };
  GlobalWorkerOptions: { workerSrc: string };
};

interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}

interface PdfPage {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: CanvasRenderingContext2D | null; viewport: unknown }) => { promise: Promise<void> };
}

interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
}

interface GroqResponse {
  choices: [{ message: { content: string } }];
  usage?: { total_tokens: number };
  error?: { message: string };
}

interface Attachment {
  type: "pdf" | "image";
  name: string;
  pages: string[];
  pageCount: number;
  mimeType?: string;
}

interface PendingChip {
  id: string;
  name: string;
  meta: string;
  ready: boolean;
}

type ChatEntry =
  | { id: string; kind: "user"; content: string; ts: string }
  | { id: string; kind: "assistant"; content: string; isError?: boolean; ts: string }
  | { id: string; kind: "info"; content: string }
  | { id: string; kind: "files"; attachments: Attachment[] }
  | { id: string; kind: "extraction"; files: ExtractionResult[]; labels: [string, string][]; ts: string };

interface Stats {
  tokens: string;
  latency: string;
  batches: number;
  pages: number;
}

interface Conversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface DBMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
}

interface ExtractionResult {
  name: string;
  error?: string;
  [key: string]: string | null | undefined;
}

interface ContextPreset {
  id: string;
  label: string;
  system: string;
  extractionSystem: string;
  extractionLabels: [string, string][];
  extractionDefaults: Record<string, null>;
  extractionQuestion: string;
}

const MODELS = [
  { value: "meta-llama/llama-4-scout-17b-16e-instruct", label: "llama-4-scout ✦" },
  { value: "llama-3.3-70b-versatile", label: "llama-3.3-70b (texto)" },
];

const CONTEXT_PRESETS: ContextPreset[] = [
  {
    id: "chatbot",
    label: "Chatbot",
    system: "Eres un asistente útil y amigable. Responde de forma clara y concisa en el idioma del usuario.",
    extractionSystem: "",
    extractionLabels: [],
    extractionDefaults: {},
    extractionQuestion: "",
  },
  {
    id: "financiero",
    label: "Financiero",
    system: `Eres un asistente experto en análisis de documentos financieros mexicanos (estados de cuenta, comprobantes, facturas).

Cuando analices un documento extrae y presenta:
- Titular / nombre del cliente
- Institución bancaria
- CLABE interbancaria
- Número de cuenta / tarjeta
- RFC
- Saldo final / deuda
- Período del estado de cuenta
- Cualquier otro dato financiero relevante

Presenta los datos en formato claro. Si recibes múltiples lotes del mismo documento, consolida toda la información al final.`,
    extractionSystem: `Eres un extractor de datos de documentos financieros mexicanos. Analiza el documento y responde ÚNICAMENTE con un objeto JSON válido (sin texto adicional, sin markdown, sin explicaciones):
{"titular":null,"institucion":null,"clabe":null,"cuenta_tarjeta":null,"rfc_cliente":null,"rfc_institucion":null,"saldo":null,"periodo":null}
Usa null para campos no encontrados. El campo "saldo" debe incluir la moneda (ej: "$31.15").`,
    extractionLabels: [
      ["titular", "Titular"],
      ["institucion", "Institución"],
      ["clabe", "CLABE"],
      ["cuenta_tarjeta", "Cuenta / Tarjeta"],
      ["rfc_cliente", "RFC Cliente"],
      ["rfc_institucion", "RFC Institución"],
      ["saldo", "Saldo"],
      ["periodo", "Período"],
    ],
    extractionDefaults: { titular: null, institucion: null, clabe: null, cuenta_tarjeta: null, rfc_cliente: null, rfc_institucion: null, saldo: null, periodo: null },
    extractionQuestion: "Extrae los campos financieros del documento en JSON.",
  },
  {
    id: "ine",
    label: "INE",
    system: `Eres un asistente experto en lectura de credenciales INE (Credencial para Votar) mexicanas.

Cuando analices una credencial INE extrae y presenta:
- Nombre completo
- CURP
- Clave de elector
- Número de emisión
- Fecha de nacimiento
- Sexo
- Domicilio completo
- Municipio / Delegación
- Estado
- Sección electoral
- Vigencia (año de vencimiento)

Presenta los datos en formato claro y organizado.`,
    extractionSystem: `Eres un extractor de datos de credenciales INE (Credencial para Votar) mexicanas. Analiza la imagen y responde ÚNICAMENTE con un objeto JSON válido (sin texto adicional, sin markdown, sin explicaciones):
{"nombre":null,"curp":null,"clave_elector":null,"num_emision":null,"fecha_nacimiento":null,"sexo":null,"domicilio":null,"municipio":null,"estado":null,"seccion":null,"vigencia":null}
Usa null para campos no encontrados.`,
    extractionLabels: [
      ["nombre", "Nombre"],
      ["curp", "CURP"],
      ["clave_elector", "Clave de Elector"],
      ["num_emision", "Núm. Emisión"],
      ["fecha_nacimiento", "Fecha Nacimiento"],
      ["sexo", "Sexo"],
      ["domicilio", "Domicilio"],
      ["municipio", "Municipio"],
      ["estado", "Estado"],
      ["seccion", "Sección Electoral"],
      ["vigencia", "Vigencia"],
    ],
    extractionDefaults: { nombre: null, curp: null, clave_elector: null, num_emision: null, fecha_nacimiento: null, sexo: null, domicilio: null, municipio: null, estado: null, seccion: null, vigencia: null },
    extractionQuestion: "Extrae los campos de la credencial INE en JSON.",
  },
];

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const nowStr = () => new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });

function tsToTime(ts: number) {
  return new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

function relativeDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Hoy";
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Ayer";
  return d.toLocaleDateString("es-MX", { month: "short", day: "numeric" });
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineStyles(text: string): string {
  return esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`\n]+)`/g, '<code class="mdinline">$1</code>');
}

function renderMarkdown(text: string): string {
  return text
    .split("\n")
    .map(line => {
      if (/^###\s/.test(line)) return `<div class="mdh3">${inlineStyles(line.slice(4))}</div>`;
      if (/^##\s/.test(line))  return `<div class="mdh2">${inlineStyles(line.slice(3))}</div>`;
      if (/^#\s/.test(line))   return `<div class="mdh1">${inlineStyles(line.slice(2))}</div>`;
      if (/^[-*]\s/.test(line)) return `<div class="mdli">${inlineStyles(line.slice(2))}</div>`;
      if (line.trim() === "")  return `<div class="mdblank"></div>`;
      return `<div class="mdp">${inlineStyles(line)}</div>`;
    })
    .join("");
}

function renderJSON(txt: string): string {
  try {
    const clean = txt.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const highlighted = esc(JSON.stringify(JSON.parse(clean), null, 2))
      .replace(/"([^"]+)":/g, '<span class="jk">"$1"</span>:')
      .replace(/: "([^"]*)"/g, ': <span class="js">"$1"</span>')
      .replace(/: (-?\d+\.?\d*)/g, ': <span class="jn">$1</span>')
      .replace(/: (true|false)/g, ': <span class="jb">$1</span>')
      .replace(/: (null)/g, ': <span class="jnu">$1</span>');
    return `<div class="jv">${highlighted}</div>`;
  } catch {
    return esc(txt);
  }
}

export function Chat() {
  // Settings
  const [model, setModel] = useState(MODELS[0].value);
  const [selectedPresetId, setSelectedPresetId] = useState("financiero");
  const [systemPrompt, setSystemPrompt] = useState(CONTEXT_PRESETS[1].system);
  const [temperature, setTemperature] = useState(0.1);
  const [maxTokens, setMaxTokens] = useState(2000);
  const [batchSize, setBatchSize] = useState(4);
  const [jsonMode, setJsonMode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Chat state
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [pendingChips, setPendingChips] = useState<PendingChip[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [stats, setStats] = useState<Stats>({ tokens: "—", latency: "—", batches: 0, pages: 0 });
  const [typingText, setTypingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [inputVal, setInputVal] = useState("");

  // History / sidebar
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadingConv, setLoadingConv] = useState<string | null>(null);

  const chatRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof pdfjsLib !== "undefined") {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    fetchConversations();
    const saved = localStorage.getItem("currentConvId");
    if (saved) loadConversation(saved);
  }, []);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [entries, typingText]);

  // ── Persistence ───────────────────────────────────────────────────────────

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/history");
      const data = await res.json() as { conversations: Conversation[] };
      setConversations(data.conversations ?? []);
    } catch {
      /* DB not ready yet — silently ignore */
    }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setLoadingConv(id);
    try {
      const res = await fetch(`/api/history/${id}`);
      if (!res.ok) {
        localStorage.removeItem("currentConvId");
        setLoadingConv(null);
        return;
      }
      const data = await res.json() as { conversation: Conversation; messages: DBMessage[] };
      const msgs = data.messages ?? [];

      setEntries(msgs.map(m => ({
        id: m.id,
        kind: m.role,
        content: m.content,
        ts: tsToTime(m.created_at),
      } as ChatEntry)));

      setHistory(msgs.map(m => ({ role: m.role, content: m.content })));
      setCurrentConvId(id);
      localStorage.setItem("currentConvId", id);
    } catch {
      localStorage.removeItem("currentConvId");
    }
    setLoadingConv(null);
  }, []);

  const saveMessages = async (
    msgs: { role: string; content: string }[],
    title?: string
  ): Promise<string | null> => {
    try {
      const res = await fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: currentConvId ?? undefined, title, messages: msgs }),
      });
      const data = await res.json() as { conversationId: string };
      return data.conversationId;
    } catch {
      return null;
    }
  };

  const removeConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/history/${id}`, { method: "DELETE" });
    if (currentConvId === id) startNewChat();
    setConversations(prev => prev.filter(c => c.id !== id));
  };

  const startNewChat = () => {
    setEntries([]);
    setHistory([]);
    setPendingAttachments([]);
    setPendingChips([]);
    setTypingText(null);
    setStats({ tokens: "—", latency: "—", batches: 0, pages: 0 });
    setCurrentConvId(null);
    localStorage.removeItem("currentConvId");
    setSidebarOpen(false);
  };

  // ── File handling ──────────────────────────────────────────────────────────

  const handleFiles = async (files: FileList) => {
    for (const file of Array.from(files)) {
      if (file.type === "application/pdf") await processPDF(file);
      else if (file.type.startsWith("image/")) await processImage(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const processPDF = async (file: File) => {
    const id = genId();
    setPendingChips(prev => [...prev, { id, name: file.name, meta: "⏳ procesando...", ready: false }]);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pages: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.8 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        pages.push(canvas.toDataURL("image/jpeg", 0.8).split(",")[1]);
        setPendingChips(prev => prev.map(c => c.id === id ? { ...c, meta: `${i}/${pdf.numPages} páginas` } : c));
      }
      setPendingAttachments(prev => [...prev, { type: "pdf", name: file.name, pages, pageCount: pdf.numPages }]);
      setPendingChips(prev => prev.map(c => c.id === id ? { ...c, meta: `${pdf.numPages} páginas listo ✓`, ready: true } : c));
    } catch {
      setPendingChips(prev => prev.map(c => c.id === id ? { ...c, name: `❌ ${file.name}`, meta: "error al procesar" } : c));
    }
  };

  const processImage = async (file: File) => {
    const id = genId();
    const b64 = await new Promise<string>(res => {
      const reader = new FileReader();
      reader.onload = e => res((e.target!.result as string).split(",")[1]);
      reader.readAsDataURL(file);
    });
    setPendingAttachments(prev => [...prev, { type: "image", name: file.name, pages: [b64], pageCount: 1, mimeType: file.type }]);
    setPendingChips(prev => [...prev, { id, name: file.name, meta: "🖼️ imagen lista ✓", ready: true }]);
  };

  // ── Groq API ───────────────────────────────────────────────────────────────

  const callGroq = async (messages: HistoryMessage[]): Promise<GroqResponse> => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model, temperature, maxTokens }),
    });
    const data = await res.json() as GroqResponse;
    if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
    return data;
  };

  const processBatches = async (
    att: Attachment,
    question: string,
    onProgress: (b: number, endPage: number, tokens: number) => void,
    sysOverride?: string,
    silent?: boolean
  ) => {
    const sys = sysOverride !== undefined ? sysOverride : systemPrompt;
    const batches: string[][] = [];
    for (let i = 0; i < att.pages.length; i += batchSize) batches.push(att.pages.slice(i, i + batchSize));

    if (!silent) push({ id: genId(), kind: "info", content: `📄 ${att.name}: ${att.pageCount} páginas → ${batches.length} lote${batches.length > 1 ? "s" : ""} de máx ${batchSize}` });

    const results: { batch: number; pages: string; text: string }[] = [];
    let totalTokens = 0;

    for (let b = 0; b < batches.length; b++) {
      const startPage = b * batchSize + 1;
      const endPage = Math.min((b + 1) * batchSize, att.pageCount);
      if (!silent) setTypingText(`Procesando lote ${b + 1}/${batches.length} (pág. ${startPage}-${endPage})...`);

      const content: ContentPart[] = [
        ...batches[b].map(p => ({ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${p}` } })),
        {
          type: "text",
          text: batches.length > 1
            ? `Estas son las páginas ${startPage} a ${endPage} de ${att.pageCount} del documento "${att.name}". ${question} Extrae toda la información relevante de estas páginas.`
            : question,
        },
      ];

      const msgs: HistoryMessage[] = sys
        ? [{ role: "system", content: sys }, { role: "user", content }]
        : [{ role: "user", content }];

      const data = await callGroq(msgs);
      totalTokens += data.usage?.total_tokens ?? 0;
      results.push({ batch: b + 1, pages: `${startPage}-${endPage}`, text: data.choices[0].message.content });
      onProgress(b + 1, endPage, totalTokens);
    }

    return { results, totalTokens };
  };

  const consolidate = async (
    results: { batch: number; pages: string; text: string }[],
    question: string,
    sysOverride?: string,
    silent?: boolean
  ): Promise<{ text: string; extraTokens: number }> => {
    const sys = sysOverride !== undefined ? sysOverride : systemPrompt;
    if (results.length === 1) return { text: results[0].text, extraTokens: 0 };
    if (!silent) setTypingText("Consolidando resultados de todos los lotes...");
    const combined = results.map(r => `[Páginas ${r.pages}]\n${r.text}`).join("\n\n---\n\n");
    const consolidateMsg = `He analizado un documento en ${results.length} lotes. Aquí está la información extraída de cada parte:\n\n${combined}\n\nAhora consolida toda esta información en una respuesta unificada y completa. Pregunta original: "${question}"`;
    const msgs: HistoryMessage[] = sys
      ? [{ role: "system", content: sys }, { role: "user", content: consolidateMsg }]
      : [{ role: "user", content: consolidateMsg }];
    const data = await callGroq(msgs);
    return { text: data.choices[0].message.content, extraTokens: data.usage?.total_tokens ?? 0 };
  };

  const extractFromFile = async (att: Attachment): Promise<ExtractionResult> => {
    const preset = CONTEXT_PRESETS.find(p => p.id === selectedPresetId) ?? CONTEXT_PRESETS[1];
    if (!preset.extractionSystem) {
      return { name: att.name, ...preset.extractionDefaults, error: "Extracción automática no disponible en modo Chatbot." };
    }
    try {
      const question = preset.extractionQuestion;
      const trimmed = { ...att, pages: att.pages.slice(0, 2), pageCount: Math.min(att.pageCount, 2) };
      const { results } = await processBatches(trimmed, question, () => {}, preset.extractionSystem, true);
      const { text } = await consolidate(results, question, preset.extractionSystem, true);
      const clean = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : clean);
      return { name: att.name, ...preset.extractionDefaults, ...parsed };
    } catch (e) {
      return { name: att.name, ...preset.extractionDefaults, error: (e as Error).message };
    }
  };

  // ── Send ───────────────────────────────────────────────────────────────────

  const push = (entry: ChatEntry) => setEntries(prev => [...prev, entry]);

  const send = async () => {
    const typedQuestion = inputVal.trim();
    const activeAtt = [...pendingAttachments];
    if (!typedQuestion && !activeAtt.length) return;

    const isExtractionMode = activeAtt.length > 0 && !typedQuestion;

    setInputVal("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setSending(true);
    setPendingAttachments([]);
    setPendingChips([]);
    setTypingText("");

    if (activeAtt.length) push({ id: genId(), kind: "files", attachments: activeAtt });

    const t0 = Date.now();

    // ── Extraction mode: files with no question → structured cards ─────────
    if (isExtractionMode) {
      push({ id: genId(), kind: "info", content: `⚡ Extrayendo datos de ${activeAtt.length} archivo${activeAtt.length > 1 ? "s" : ""}...` });
      try {
        const activePreset = CONTEXT_PRESETS.find(p => p.id === selectedPresetId) ?? CONTEXT_PRESETS[1];
        const results = await Promise.all(activeAtt.map(att => extractFromFile(att)));
        setTypingText(null);
        push({ id: genId(), kind: "extraction", files: results, labels: activePreset.extractionLabels, ts: nowStr() });

        const summaryFields = activePreset.extractionLabels.slice(0, 3);
        const summary = results.map(r =>
          `**${r.name}**\n` + (summaryFields.length
            ? summaryFields.map(([k, l]) => `${l}: ${r[k] ?? "-"}`).join(" | ")
            : r.error ?? "extraído")
        ).join("\n\n");
        const isNew = !currentConvId;
        const convId = await saveMessages(
          [{ role: "user", content: `[Extracción: ${activeAtt.map(a => a.name).join(", ")}]` }, { role: "assistant", content: summary }],
          isNew ? `Extracción: ${activeAtt.map(a => a.name).join(", ").slice(0, 60)}` : undefined
        );
        if (convId && isNew) { setCurrentConvId(convId); localStorage.setItem("currentConvId", convId); }
        fetchConversations();
      } catch (e: unknown) {
        setTypingText(null);
        push({ id: genId(), kind: "assistant", content: `Error: ${(e as Error).message}`, isError: true, ts: nowStr() });
      }
      setSending(false);
      textareaRef.current?.focus();
      return;
    }

    // ── Chat mode: text question (with or without files) ───────────────────
    const question = typedQuestion;
    push({ id: genId(), kind: "user", content: question, ts: nowStr() });

    try {
      let finalReply = "";
      let persistedUserContent = question;

      if (activeAtt.length === 0) {
        const nextHistory: HistoryMessage[] = [...history, { role: "user", content: question }];
        const msgs: HistoryMessage[] = systemPrompt
          ? [{ role: "system", content: systemPrompt }, ...nextHistory]
          : [...nextHistory];
        const data = await callGroq(msgs);
        finalReply = data.choices[0].message.content;
        setStats(prev => ({ ...prev, tokens: String(data.usage?.total_tokens ?? "—") }));
        setHistory([...nextHistory, { role: "assistant", content: finalReply }]);
      } else {
        let accumTokens = 0;
        let lastBatches = 0;
        let lastPages = 0;
        const allResults: { batch: number; pages: string; text: string }[] = [];

        for (const att of activeAtt) {
          const { results, totalTokens } = await processBatches(att, question, (b, endPage, tokens) => {
            accumTokens = tokens;
            lastBatches = b;
            lastPages = endPage;
            setStats(prev => ({ ...prev, batches: b, pages: endPage, tokens: String(tokens) }));
          });
          accumTokens = totalTokens;
          allResults.push(...results);
        }

        const { text, extraTokens } = await consolidate(allResults, question);
        finalReply = text;
        accumTokens += extraTokens;
        setStats(prev => ({ ...prev, tokens: String(accumTokens), batches: lastBatches, pages: lastPages }));

        persistedUserContent = `[Documento adjunto] ${question}`;
        setHistory(prev => [
          ...prev,
          { role: "user", content: persistedUserContent },
          { role: "assistant", content: finalReply },
        ]);
      }

      const lat = Date.now() - t0;
      setTypingText(null);
      push({ id: genId(), kind: "assistant", content: finalReply, ts: nowStr() });
      setStats(prev => ({ ...prev, latency: `${lat}ms` }));

      // Persist to DB
      const isNew = !currentConvId;
      const convId = await saveMessages(
        [{ role: "user", content: persistedUserContent }, { role: "assistant", content: finalReply }],
        isNew ? question.slice(0, 60) : undefined
      );
      if (convId) {
        if (isNew) {
          setCurrentConvId(convId);
          localStorage.setItem("currentConvId", convId);
        }
        fetchConversations();
      }
    } catch (e: unknown) {
      setTypingText(null);
      push({ id: genId(), kind: "assistant", content: `Error: ${(e as Error).message}`, isError: true, ts: nowStr() });
    }

    setSending(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sending) send();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputVal(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      {/* Sidebar overlay (mobile) */}
      {sidebarOpen && <div className={styles.sidebarOverlay} onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <nav className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Chats</span>
          <button className={styles.newChatBtn} onClick={startNewChat} title="Nuevo chat">＋</button>
        </div>
        <div className={styles.convList}>
          {conversations.length === 0 && (
            <div className={styles.convEmpty}>sin historial</div>
          )}
          {conversations.map(conv => (
            <button
              key={conv.id}
              className={`${styles.convItem} ${conv.id === currentConvId ? styles.convActive : ""}`}
              onClick={() => { loadConversation(conv.id); setSidebarOpen(false); }}
              disabled={loadingConv === conv.id}
            >
              <div className={styles.convTitle}>{conv.title}</div>
              <div className={styles.convMeta}>{relativeDate(conv.updated_at)}</div>
              <button
                className={styles.convDelete}
                onClick={e => removeConversation(conv.id, e)}
                title="Eliminar"
              >✕</button>
            </button>
          ))}
        </div>
      </nav>

      {/* Main column */}
      <div className={styles.mainCol}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <button className={styles.menuBtn} onClick={() => setSidebarOpen(o => !o)}>☰</button>
            <div className={styles.logo}>
              <div className={styles.dot} />
              <div className={styles.logoTxt}>groq<span>_docs</span></div>
            </div>
          </div>
          <div className={styles.headerRight}>
            <select className={styles.modelSel} value={model} onChange={e => setModel(e.target.value)}>
              {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <button className={styles.iconBtn} onClick={() => setDrawerOpen(true)}>⚙</button>
            <button className={`${styles.iconBtn} ${styles.danger}`} onClick={startNewChat}>✕</button>
          </div>
        </header>

        {/* Chat area */}
        <div className={styles.chat} ref={chatRef} onDragOver={e => e.preventDefault()} onDrop={handleDrop}>
          {entries.length === 0 && typingText === null && (
            <div className={styles.empty}>
              <div className={styles.ei}>📄</div>
              <div className={styles.et}>
                adjunta un PDF o imagen con 📎<br />
                PDFs largos se procesan en lotes<br />
                historial guardado automáticamente
              </div>
            </div>
          )}

          {entries.map(entry => {
            if (entry.kind === "files") {
              return (
                <div key={entry.id} className={styles.attachedFiles}>
                  {entry.attachments.map((att, i) => (
                    <div key={i} className={styles.fileChip}>
                      <span className={styles.ficon}>{att.type === "pdf" ? "📄" : "🖼️"}</span>
                      <div>
                        <div className={styles.fname}>{att.name}</div>
                        <div className={styles.fmeta}>{att.pageCount}p</div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            }
            if (entry.kind === "info") {
              return (
                <div key={entry.id} className={styles.msg}>
                  <div className={`${styles.bubble} ${styles.bubbleInfo}`}>{entry.content}</div>
                </div>
              );
            }

            if (entry.kind === "extraction") {
              const LABELS = entry.labels;
              return (
                <div key={entry.id} className={styles.extractionGrid}>
                  {entry.files.map((file, fi) => (
                    <div key={fi} className={styles.extractionCard}>
                      <div className={styles.extractionCardHead}>
                        <span>📄</span>
                        <span className={styles.extractionCardName}>{file.name}</span>
                        <span className={styles.extractionCardTs}>{entry.ts}</span>
                      </div>
                      {file.error ? (
                        <div className={styles.extractionError}>Error: {file.error}</div>
                      ) : (
                        <div className={styles.extractionBody}>
                          {LABELS.map(([key, label]) => (
                            <div key={key} className={styles.extractionRow}>
                              <span className={styles.extractionKey}>{label}</span>
                              <span className={file[key] ? styles.extractionVal : styles.extractionNull}>
                                {file[key] ?? "—"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            }

            const bubbleCls = entry.kind === "user"
              ? styles.bubbleUser
              : entry.isError ? styles.bubbleError : styles.bubbleAssistant;
            return (
              <div key={entry.id} className={styles.msg}>
                <div className={styles.mmeta}>
                  <span className={`${styles.role} ${styles[entry.kind]}`}>{entry.kind}</span>
                  <span>{entry.ts}</span>
                </div>
                <div className={`${styles.bubble} ${bubbleCls}`}>
                  {entry.kind === "assistant"
                    ? <div dangerouslySetInnerHTML={{ __html: jsonMode ? renderJSON(entry.content) : renderMarkdown(entry.content) }} />
                    : entry.content}
                </div>
              </div>
            );
          })}

          {typingText !== null && (
            <div className={styles.msg}>
              <div className={styles.mmeta}>
                <span className={`${styles.role} ${styles.assistant}`}>assistant</span>
              </div>
              {typingText === ""
                ? <div className={styles.typing}><span /><span /><span /></div>
                : <div className={`${styles.bubble} ${styles.bubbleInfo}`}>{typingText}</div>}
            </div>
          )}
        </div>

        {/* Input bar */}
        <div className={styles.inputBar}>
          {pendingChips.length > 0 && (
            <div className={styles.pendingFiles}>
              {pendingChips.map(chip => (
                <div key={chip.id} className={styles.fileChip}>
                  <span className={styles.ficon}>📄</span>
                  <div>
                    <div className={styles.fname}>{chip.name}</div>
                    <div className={styles.fmeta} style={{ color: chip.ready ? "var(--accent)" : "var(--text3)" }}>
                      {chip.meta}
                    </div>
                  </div>
                  <button className={styles.fremove} onClick={() => setPendingChips(p => p.filter(c => c.id !== chip.id))}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className={styles.inputRow}>
            <button className={styles.attachBtn} onClick={() => fileInputRef.current?.click()}>📎</button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,image/*"
              style={{ display: "none" }}
              onChange={e => e.target.files && handleFiles(e.target.files)}
            />
            <textarea
              ref={textareaRef}
              className={styles.mi}
              placeholder="Pregunta sobre el documento (sin texto = extracción automática de datos)"
              rows={1}
              value={inputVal}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
            />
            <button className={styles.send} onClick={send} disabled={sending}>
              <svg viewBox="0 0 24 24"><path d="M2 21L23 12 2 3v7l15 2-15 2z" /></svg>
            </button>
          </div>
        </div>
      </div>

      {/* Settings overlay */}
      {drawerOpen && <div className={styles.overlay} onClick={() => setDrawerOpen(false)} />}

      {/* Settings drawer */}
      <div className={`${styles.drawer} ${drawerOpen ? styles.drawerOpen : ""}`}>
        <div className={styles.drawerHd}>
          <span className={styles.drawerTitle}>Configuración</span>
          <button className={styles.closeX} onClick={() => setDrawerOpen(false)}>×</button>
        </div>
        <div className={styles.drawerBody}>
          <div>
            <div className={styles.flabel}>Contexto</div>
            <div className={styles.presetRow}>
              {CONTEXT_PRESETS.map(p => (
                <button
                  key={p.id}
                  className={`${styles.presetBtn} ${selectedPresetId === p.id ? styles.presetBtnActive : ""}`}
                  onClick={() => { setSelectedPresetId(p.id); setSystemPrompt(p.system); }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className={styles.flabel}>System Prompt</div>
            <textarea className={styles.sysp} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} />
          </div>
          <div>
            <div className={styles.flabel}>Parámetros</div>
            <div className={styles.prow}>
              <span className={styles.plbl}>Temperature</span>
              <span className={styles.pval}>{temperature.toFixed(1)}</span>
            </div>
            <input type="range" min="0" max="2" step="0.1" value={temperature}
              onChange={e => setTemperature(parseFloat(e.target.value))} />
            <div className={styles.prow} style={{ marginTop: 14 }}>
              <span className={styles.plbl}>Max tokens</span>
              <span className={styles.pval}>{maxTokens}</span>
            </div>
            <input type="range" min="100" max="8000" step="100" value={maxTokens}
              onChange={e => setMaxTokens(parseInt(e.target.value))} />
            <div className={styles.prow} style={{ marginTop: 14 }}>
              <span className={styles.plbl}>Págs. por lote</span>
              <span className={styles.pval}>{batchSize}</span>
            </div>
            <input type="range" min="1" max="5" step="1" value={batchSize}
              onChange={e => setBatchSize(parseInt(e.target.value))} />
          </div>
          <div>
            <div className={styles.flabel}>Opciones</div>
            <div className={styles.trow} onClick={() => setJsonMode(j => !j)}>
              <div className={`${styles.tog} ${jsonMode ? styles.togOn : ""}`} />
              <span className={styles.tlbl}>Renderizar JSON</span>
            </div>
          </div>
          <div>
            <div className={styles.flabel}>Stats</div>
            <div className={styles.statsGrid}>
              <div className={styles.sc}><div className={styles.sk}>tokens</div><div className={styles.sv}>{stats.tokens}</div></div>
              <div className={styles.sc}><div className={styles.sk}>latencia</div><div className={styles.sv}>{stats.latency}</div></div>
              <div className={styles.sc}><div className={styles.sk}>lotes</div><div className={styles.sv}>{stats.batches}</div></div>
              <div className={styles.sc}><div className={styles.sk}>páginas</div><div className={styles.sv}>{stats.pages}</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
