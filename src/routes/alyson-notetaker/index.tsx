import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader, EmptyState } from "@/components/AppShell";
import {
  listNotetakerSessions,
  createNotetakerRecallBot,
  generateNotetakerNotes,
  type NotetakerTranscriptLine,
} from "@/lib/alyson-notetaker-functions";
import { getNotetakerSession, loadNotetakerSessionArchive } from "@/lib/notetaker-get-session-functions";
import { Captions, Plus, RefreshCw, Sparkles, Copy, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { askMiniModuleAi } from "@/lib/mini-module-ai";
import { finalizeAndPersistNotetakerSession } from "@/lib/notetaker-persistence-functions";
import { syncNotetakerSessionsIndexToS3 } from "@/lib/notetaker-sessions-s3-functions";
import { deleteNotetakerSessionFromS3 } from "@/lib/notetaker-delete-functions";
import { generateSmartMeetingNotes } from "@/lib/notetaker-smart-notes";

export const Route = createFileRoute("/alyson-notetaker/")({
  component: AlysonNotetakerPage,
});

function AlysonNotetakerPage() {
  const sessionsQ = useQuery({
    queryKey: ["alyson-notetaker", "sessions"],
    queryFn: () => listNotetakerSessions(),
    staleTime: 20_000,
    gcTime: 5 * 60_000,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [sessionsSearch, setSessionsSearch] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBotId, setDeleteBotId] = useState<string | null>(null);
  const [deleteTitle, setDeleteTitle] = useState<string>("");
  const [deleteCode, setDeleteCode] = useState("");

  const deleteM = useMutation({
    mutationFn: async () =>
      deleteNotetakerSessionFromS3({
        data: { botId: deleteBotId!, code: deleteCode.trim() },
      }),
    onSuccess: async (res) => {
      toast.success(res.deleted ? "Deleted from S3" : "Nothing to delete");
      setDeleteOpen(false);
      setDeleteBotId(null);
      setDeleteTitle("");
      setDeleteCode("");
      if (picked && deleteBotId && picked === deleteBotId) setPicked(null);
      await sessionsQ.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  useEffect(() => {
    if (!picked && sessionsQ.data?.sessions?.[0]?.botId) {
      setPicked(sessionsQ.data.sessions[0].botId);
    }
  }, [picked, sessionsQ.data]);

  const sessions = sessionsQ.data?.sessions ?? [];
  const hasRecallConfig = sessionsQ.data?.hasRecallConfig ?? false;
  const sessionsLoading = sessionsQ.isLoading && !sessionsQ.data;
  const filteredSessions = useMemo(() => {
    const q = sessionsSearch.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const title = String(s.title || "").toLowerCase();
      const id = String(s.botId || "").toLowerCase();
      return title.includes(q) || id.includes(q);
    });
  }, [sessions, sessionsSearch]);

  if (sessionsQ.isError && !sessionsQ.data) {
    const msg = sessionsQ.error instanceof Error ? sessionsQ.error.message : "Failed to load sessions.";
    return (
      <div className="ops-dense">
        <PageHeader eyebrow="Operations" title="Alyson Notetaker" description="Recall.ai meeting bot + live transcript + notes." dense />
        <div className="px-5 md:px-8 py-6">
          <div className="surface-card p-5">
            <div className="font-medium">Unable to load Alyson Notetaker</div>
            <div className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{msg}</div>
            <div className="mt-4">
              <button
                onClick={() => sessionsQ.refetch()}
                className="h-8 px-3 rounded-md bg-foreground text-background text-xs flex items-center gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ops-dense">
      {deleteOpen && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 px-4">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background shadow-xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-[14px]">Delete session from S3</div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  This removes the persisted transcript/notes from S3 so it disappears from the calendar.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (deleteM.isPending) return;
                  setDeleteOpen(false);
                  setDeleteBotId(null);
                  setDeleteTitle("");
                  setDeleteCode("");
                }}
                className="h-8 w-8 grid place-items-center rounded-md hover:bg-muted text-muted-foreground"
                aria-label="Close"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 text-[12px] text-muted-foreground">
              Session: <span className="font-mono text-foreground">{deleteBotId}</span>
              {deleteTitle ? <span className="block mt-1 truncate">Title: {deleteTitle}</span> : null}
            </div>

            <div className="mt-3">
              <div className="text-[12px] font-medium">Enter Super Admin code to confirm</div>
              <input
                value={deleteCode}
                onChange={(e) => setDeleteCode(e.target.value.replace(/\D/g, "").slice(0, 5))}
                inputMode="numeric"
                placeholder="•••••"
                className="mt-2 w-full h-10 rounded-md border border-border bg-background px-3 font-mono text-[16px] tracking-[0.25em]"
                autoFocus
              />
              {deleteM.isError && (
                <div className="mt-2 text-[12px] text-destructive whitespace-pre-wrap">
                  {deleteM.error instanceof Error ? deleteM.error.message : "Delete failed"}
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (deleteM.isPending) return;
                  setDeleteOpen(false);
                  setDeleteBotId(null);
                  setDeleteTitle("");
                  setDeleteCode("");
                }}
                className="h-9 px-3 rounded-md border border-border text-[12px] hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!deleteBotId || deleteCode.trim().length !== 5 || deleteM.isPending}
                onClick={() => deleteM.mutate()}
                className="h-9 px-3 rounded-md bg-destructive text-destructive-foreground text-[12px] hover:opacity-90 disabled:opacity-50"
              >
                {deleteM.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      <PageHeader
        eyebrow="Operations"
        title="Alyson Notetaker"
        description="Create a Recall bot for a meeting, stream transcripts live, and generate notes."
        dense
        actions={
          <Link
            to="/alyson-notetaker/calendar"
            onClick={() => toast.message("Calendar view")}
            reloadDocument
            className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
          >
            Calendar
          </Link>
        }
      />
      <div className="px-5 md:px-8 py-6">
        {!hasRecallConfig && (
          <div className="surface-card p-4 border border-border mb-5">
            <div className="font-medium text-[13px]">Server not configured</div>
            <div className="text-[12px] text-muted-foreground mt-1">
              Set `RECALL_API_KEY` and `PUBLIC_WEBHOOK_BASE_URL` (and optional Groq keys) and run the notetaker server.
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
          <div className="surface-card p-4">
            <CreateBotForm
              onCreated={async (botId) => {
                await sessionsQ.refetch();
                if (botId) setPicked(botId);
              }}
            />
            <div className="mt-4 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Sessions</div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await syncNotetakerSessionsIndexToS3({ data: {} });
                      toast.success("Sessions persisted to S3");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed to persist sessions");
                    }
                  }}
                  className="h-6 px-2 rounded-md border border-border bg-background text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/40"
                  title="Persist the current sessions list to S3"
                >
                  Persist list
                </button>
              </div>

              <input
                value={sessionsSearch}
                onChange={(e) => setSessionsSearch(e.target.value)}
                placeholder="Search sessions…"
                className="w-full h-8 px-3 rounded-md border border-border bg-background text-[13px] mb-2"
              />

              {sessionsLoading ? (
                <div className="space-y-2 py-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-12 rounded-md bg-muted/50 animate-pulse" />
                  ))}
                </div>
              ) : filteredSessions.length === 0 ? (
                <EmptyState
                  icon={Captions}
                  title="No sessions yet"
                  description="Create a bot for a live meeting, or open a past meeting after Persist to S3."
                />
              ) : (
                <div className="max-h-[520px] overflow-y-auto pr-1 space-y-1">
                  {filteredSessions.map((s) => (
                    <button
                      key={s.botId}
                      onClick={() => setPicked(s.botId)}
                      className={
                        "w-full text-left px-3 py-2 rounded-md border transition-colors " +
                        (picked === s.botId ? "bg-muted border-border" : "bg-background border-border/60 hover:bg-muted/40")
                      }
                    >
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-[13px] truncate flex items-center gap-1.5">
                            <span className="truncate">{s.title || "Meeting"}</span>
                            {String(s.status || "").toLowerCase() === "persisted" && (
                              <span className="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wide bg-muted text-muted-foreground">
                                S3
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate">{s.botId}</div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteOpen(true);
                            setDeleteBotId(String(s.botId));
                            setDeleteTitle(String(s.title || ""));
                            setDeleteCode("");
                          }}
                          className="shrink-0 h-7 w-7 grid place-items-center rounded-md border border-border bg-background text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10"
                          aria-label="Delete session"
                          title="Delete session from S3"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <SessionPanel
            botId={picked}
            fallbackTitle={sessions.find((s) => s.botId === picked)?.title || null}
            onSessionsChange={() => sessionsQ.refetch()}
            deferLoad={sessionsLoading}
          />
        </div>
      </div>
    </div>
  );
}

function CreateBotForm({ onCreated }: { onCreated: (botId: string | null) => void }) {
  const [meetingUrl, setMeetingUrl] = useState("");
  const [title, setTitle] = useState("");
  const [botName, setBotName] = useState("Notetaker");
  const [avatarB64, setAvatarB64] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const svgUrl = "/images/alyson-mini.svg";
        const res = await fetch(svgUrl);
        if (!res.ok) return;
        const svgText = await res.text();
        const blob = new Blob([svgText], { type: "image/svg+xml" });
        const objUrl = URL.createObjectURL(blob);

        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Failed to load avatar"));
          img.src = objUrl;
        });
        URL.revokeObjectURL(objUrl);

        const w = 1280;
        const h = 720;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Solid background helps video tiles look like a "logo".
        ctx.fillStyle = "#0b1020";
        ctx.fillRect(0, 0, w, h);

        const padding = 96;
        const maxW = w - padding * 2;
        const maxH = h - padding * 2;
        const scale = Math.min(maxW / img.width, maxH / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;
        ctx.drawImage(img, dx, dy, dw, dh);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        const b64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        if (!cancelled) setAvatarB64(b64);
      } catch {
        // best-effort; bot creation still works without an avatar
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const m = useMutation({
    mutationFn: async () =>
      createNotetakerRecallBot({
        data: {
          meeting_url: meetingUrl.trim(),
          bot_name: botName.trim(),
          title: title.trim() || undefined,
          avatar_jpeg_b64: avatarB64 || undefined,
        },
      }),
    onSuccess: (res: any) => onCreated(res?.botId ? String(res.botId) : null),
  });

  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium mb-2">New meeting bot</div>
      <div className="space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          className="w-full h-8 px-3 rounded-md border border-border bg-background text-[13px]"
        />
        <input
          value={meetingUrl}
          onChange={(e) => setMeetingUrl(e.target.value)}
          placeholder="Meeting URL (Zoom/Meet/Teams)"
          className="w-full h-8 px-3 rounded-md border border-border bg-background text-[13px]"
        />
        <div className="flex gap-2">
          <input
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            placeholder="Bot name"
            className="flex-1 h-8 px-3 rounded-md border border-border bg-background text-[13px]"
          />
          <button
            onClick={() => m.mutate()}
            disabled={!meetingUrl.trim() || !botName.trim() || m.isPending}
            className="h-8 px-3 rounded-md bg-foreground text-background text-xs flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Create
          </button>
        </div>
        {m.isError && (
          <div className="text-[12px] text-red-500 whitespace-pre-wrap">
            {m.error instanceof Error ? m.error.message : "Failed to create bot."}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionPanel({
  botId,
  fallbackTitle,
  onSessionsChange,
  deferLoad,
}: {
  botId: string | null;
  fallbackTitle?: string | null;
  onSessionsChange?: () => void;
  deferLoad?: boolean;
}) {
  const qc = useQueryClient();
  const autoPersistToastRef = useRef<string | null>(null);
  const base =
    (import.meta as any).env?.VITE_ALYSON_NOTETAKER_BASE_URL || (import.meta as any).env?.VITE_TEST_BOTV2_BASE_URL || "http://localhost:3002";

  const q = useQuery({
    queryKey: ["alyson-notetaker", "session", botId],
    queryFn: async () => {
      try {
        const res = await getNotetakerSession({ data: { botId: botId! } });
        if (!res?.session) {
          throw new Error(
            "Session data was empty. Stop the dev server, run npm run dev again, then hard-refresh the page (Ctrl+Shift+R).",
          );
        }
        return res as any;
      } catch (e) {
        try {
          return (await loadNotetakerSessionArchive({ data: { botId: botId! } })) as any;
        } catch {
          const message = e instanceof Error ? e.message : "Session metadata unavailable";
          return {
            session: {
              botId: botId!,
              title: String(fallbackTitle || "Live unified meeting"),
              createdAt: new Date().toISOString(),
              status: "scheduled",
            },
            lines: [],
            participantCount: 0,
            startedLabel: "",
            hasRecallConfig: true,
            hasGroqConfig: true,
            _fallbackError: message,
          } as any;
        }
      }
    },
    enabled: Boolean(botId) && !deferLoad,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  const [live, setLive] = useState<NotetakerTranscriptLine[]>([]);
  const lastStaticLinesRef = useRef<NotetakerTranscriptLine[]>([]);
  const [notes, setNotes] = useState<string>("");
  const [notesModel, setNotesModel] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [transcriptCopied, setTranscriptCopied] = useState(false);
  // Keep header clock real-time in IST.
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  type ChatMsg = { role: "user" | "assistant"; content: string };
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([
    { role: "assistant", content: "Ask me questions about this meeting only. I will answer using the transcript + notes." },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const mergedLines = useMemo(() => {
    const fetched = q.data?.lines ?? [];
    if (fetched.length) lastStaticLinesRef.current = fetched;
    const staticLines = fetched.length ? fetched : lastStaticLinesRef.current;
    const all = [...staticLines, ...live];
    const seen = new Set<string>();
    const uniq: NotetakerTranscriptLine[] = [];
    for (const L of all) {
      const key = `${L.received_at}|${L.text || ""}|${L.participant?.id || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(L);
    }
    uniq.sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime());
    return uniq;
  }, [q.data, live]);

  const session = q.data?.session;
  const fallbackError = String((q.data as any)?._fallbackError || "");
  const isSessionFallback = Boolean(fallbackError);
  const showMetadataWarning = isSessionFallback && mergedLines.length === 0;
  const plainNotes = notes ? notesToPlainText(notes) : "";
  const plainTranscript = mergedLines
    .map((L) => {
      const who = (L.participant?.name || "Speaker").trim();
      const text = String(L.text || "").trim();
      if (!text) return "";
      return `${who}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");

  const contextText = useMemo(() => {
    const s = session;
    const header = [
      "Meeting context (source of truth):",
      s?.title ? `Title: ${s.title}` : "",
      s?.meetingUrl ? `Meeting URL: ${s.meetingUrl}` : "",
      s?.createdAt ? `Created at: ${s.createdAt}` : "",
      "",
      "Transcript (chronological):",
    ]
      .filter(Boolean)
      .join("\n");

    // Keep context bounded so chat doesn't fail on longer meetings.
    const transcriptLines = (plainTranscript || "(no transcript lines)").split("\n").filter(Boolean);
    const transcriptTail = transcriptLines.slice(-220).join("\n"); // last N lines is usually enough
    const notesTrimmed = plainNotes ? plainNotes.slice(0, 8000) : "";
    const notesBlock = notesTrimmed
      ? `\n\nMeeting notes (generated):\n${notesTrimmed}\n`
      : "\n\nMeeting notes (generated):\n(none)\n";
    return (header + "\n" + transcriptTail + notesBlock).slice(0, 14_000);
  }, [session, plainTranscript, plainNotes]);

  useEffect(() => {
    setLive([]);
    lastStaticLinesRef.current = [];
    setNotes("");
    setNotesModel("");
    setChatMsgs([{ role: "assistant", content: "Ask me questions about this meeting only. I will answer using the transcript + notes." }]);
    setChatInput("");
    setChatLoading(false);
    if (!botId) return;
    const url = `${String(base).replace(/\/$/, "")}/session/${encodeURIComponent(botId)}/events`;
    const es = new EventSource(url);
    es.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data || "{}");
        if (msg?.type === "line" && msg?.line) {
          setLive((prev) => [...prev, msg.line]);
        }
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      es.close();
    };
    return () => es.close();
  }, [botId, base]);

  useEffect(() => {
    const t = window.setInterval(() => setNowIso(new Date().toISOString()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!q.data?.notesMd?.trim()) return;
    setNotes(q.data.notesMd);
    setNotesModel(q.data.notesModel || "s3");
  }, [botId, q.data?.notesMd, q.data?.notesModel]);

  useEffect(() => {
    if (!q.data?.autoPersistedToS3 || !botId) return;
    if (autoPersistToastRef.current === botId) return;
    autoPersistToastRef.current = botId;
    toast.success("Meeting auto-saved to S3");
    void qc.invalidateQueries({ queryKey: ["alyson-notetaker", "sessions"] });
    onSessionsChange?.();
  }, [q.data?.autoPersistedToS3, botId, qc, onSessionsChange]);

  const notesM = useMutation({
    mutationFn: async (prompt?: string) => {
      // For very large transcripts, avoid upstream token exhaustion by chunking locally.
      if (plainTranscript.length > 22_000) {
        return await generateSmartMeetingNotes({ data: { title: session?.title || "Meeting", transcriptText: plainTranscript } });
      }
      try {
        const res = await generateNotetakerNotes({ data: { botId: botId!, prompt } });
        if (!String(res?.notes || "").trim()) {
          return await generateSmartMeetingNotes({ data: { title: session?.title || "Meeting", transcriptText: plainTranscript } });
        }
        return res;
      } catch {
        return await generateSmartMeetingNotes({ data: { title: session?.title || "Meeting", transcriptText: plainTranscript } });
      }
    },
    onSuccess: (res) => {
      setNotes(res.notes);
      setNotesModel(res.model);
      setCopied(false);
    },
  });

  const persistM = useMutation({
    mutationFn: async () => finalizeAndPersistNotetakerSession({ data: { botId: botId! } }),
    onSuccess: () => {
      toast.success("Meeting persisted to S3");
      void q.refetch();
      void qc.invalidateQueries({ queryKey: ["alyson-notetaker", "sessions"] });
      onSessionsChange?.();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to persist meeting"),
  });

  if (!botId || deferLoad) {
    return (
      <div className="surface-card p-10 text-center text-[13px] text-muted-foreground">
        {deferLoad ? "Loading sessions…" : "Pick a session to view transcript."}
      </div>
    );
  }
  if (q.isLoading && !q.data) {
    return <div className="surface-card p-6"><div className="text-sm text-muted-foreground">Loading session…</div></div>;
  }
  const sendChat = async () => {
    const question = chatInput.trim();
    if (!question || chatLoading) return;
    const next: ChatMsg[] = [...chatMsgs, { role: "user", content: question }, { role: "assistant", content: "" }];
    setChatMsgs(next);
    setChatInput("");
    setChatLoading(true);
    try {
      const history = next
        .slice(0, -1)
        .slice(-10)
        .map((m) => ({ ...m, content: String(m.content || "").slice(0, 800) }));
      const res = await askMiniModuleAi({
        data: {
          pagePath: "/alyson-notetaker",
          question,
          contextText,
          history,
        },
      });
      setChatMsgs((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: res.answer };
        return copy;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to chat.";
      setChatMsgs((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${msg}` };
        return copy;
      });
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <div className="surface-card p-4">
      {showMetadataWarning && (
        <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          Session metadata is not available yet. Live transcript will appear here when the bot streams events.
        </div>
      )}
      {isSessionFallback && mergedLines.length > 0 && (
        <div className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
          Loaded from live stream; saving to S3 when the meeting ends.
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-[14px] truncate flex items-center gap-2">
            <span className="truncate">{session?.title || "Meeting"}</span>
            {q.data?.persistedInS3 && (
              <span className="shrink-0 text-[10px] rounded px-1.5 py-0.5 bg-muted text-muted-foreground">S3</span>
            )}
          </div>
          <div className="text-[12px] text-muted-foreground truncate">{botId}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => notesM.mutate(undefined)}
            disabled={notesM.isPending}
            className="h-8 px-3 rounded-md border border-border bg-background text-xs flex items-center gap-1.5 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" /> Generate notes
          </button>
          <button
            onClick={() => persistM.mutate()}
            disabled={persistM.isPending || mergedLines.length === 0}
            className="h-8 px-3 rounded-md bg-foreground text-background text-xs flex items-center gap-1.5 disabled:opacity-50"
            title="Persist transcript + notes to S3"
          >
            Persist
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-muted/30 text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium flex items-center justify-between">
            <span>Live transcript</span>
            <span className="normal-case tracking-normal text-[11px] flex items-center gap-2">
              <span className="text-muted-foreground/90" title="Indian Standard Time">
                IST {istDateTimeFromIso(nowIso)}
              </span>
              <button
                type="button"
                onClick={async () => {
                  if (!plainTranscript.trim()) return;
                  await navigator.clipboard.writeText(plainTranscript);
                  setTranscriptCopied(true);
                  toast.success("Transcript copied to clipboard");
                  window.setTimeout(() => setTranscriptCopied(false), 1200);
                }}
                disabled={!plainTranscript.trim()}
                className="h-6 w-6 grid place-items-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-50"
                title={transcriptCopied ? "Copied" : "Copy transcript"}
                aria-label="Copy transcript"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <span>{mergedLines.length} lines</span>
            </span>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            {mergedLines.length === 0 ? (
              <div className="p-6 text-[13px] text-muted-foreground">No transcript lines yet.</div>
            ) : (
              <div className="divide-y divide-border">
                {mergedLines.map((L, i) => (
                  <div key={`${L.received_at}-${i}`} className="p-3">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <div className="h-6 w-6 rounded-full bg-muted grid place-items-center text-[10px] font-medium text-foreground">
                        {(L.initials || (L.participant?.name ? initialsFromName(L.participant.name) : "?")).slice(0, 2)}
                      </div>
                      <div className="truncate">{L.participant?.name || "Speaker"}</div>
                      <div className="ml-auto" title={istDateTimeFromIso(L.received_at)}>
                        {istClockFromIso(L.received_at)}
                      </div>
                    </div>
                    <div className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{(L.text || "").trim()}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium">
              Notes {notesModel ? <span className="normal-case tracking-normal text-[11px] ml-1 opacity-70">({notesModel})</span> : null}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={async () => {
                  if (!plainNotes.trim()) return;
                  await navigator.clipboard.writeText(plainNotes);
                  setCopied(true);
                  toast.success("Text copied to clipboard");
                  window.setTimeout(() => setCopied(false), 1200);
                }}
                disabled={!plainNotes.trim()}
                className="h-7 w-7 grid place-items-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-50"
                title={copied ? "Copied" : "Copy notes"}
                aria-label="Copy notes"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!plainNotes.trim()) return;
                  const title = session?.title ? `Meeting notes — ${session.title}` : "Meeting notes";
                  try {
                    if ("share" in navigator && typeof navigator.share === "function") {
                      await navigator.share({ title, text: plainNotes });
                      return;
                    }
                  } catch {
                    // fall through to mailto
                  }
                  const url = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(plainNotes)}`;
                  window.open(url, "_blank", "noopener,noreferrer");
                }}
                disabled={!plainNotes.trim()}
                className="h-7 w-7 grid place-items-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-50"
                title="Send notes"
                aria-label="Send notes"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="p-4">
            {notesM.isError && (
              <div className="text-[12px] text-red-500 whitespace-pre-wrap mb-3">
                {notesM.error instanceof Error ? notesM.error.message : "Failed to generate notes."}
              </div>
            )}
            {notes ? (
              <div className="text-[13px] whitespace-pre-wrap leading-relaxed">{plainNotes}</div>
            ) : (
              <div className="text-[13px] text-muted-foreground">Generate notes to summarize the transcript.</div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Chat about this meeting</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                const text = chatMsgs
                  .map((m) => {
                    const role = m.role === "user" ? "User" : "Alyson";
                    const body = String(m.content || "").trim();
                    return body ? `${role}: ${body}` : "";
                  })
                  .filter(Boolean)
                  .join("\n\n");
                if (!text.trim()) return;
                await navigator.clipboard.writeText(text);
                toast.success("Chat copied to clipboard");
              }}
              className="h-6 w-6 grid place-items-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40"
              title="Copy chat"
              aria-label="Copy chat"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <div className="text-[11px] text-muted-foreground truncate">Uses transcript + notes</div>
          </div>
        </div>
        <div className="p-3">
          <div className="max-h-[260px] overflow-y-auto space-y-2">
            {chatMsgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "ml-auto max-w-[85%]" : "max-w-[90%]"}>
                <div
                  className={
                    "rounded-lg px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap " +
                    (m.role === "user" ? "bg-foreground text-background" : "bg-muted/60 text-foreground")
                  }
                >
                  {m.content || (chatLoading && i === chatMsgs.length - 1 ? "…" : "")}
                </div>
              </div>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendChat();
            }}
            className="mt-3 flex gap-2"
          >
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask about decisions, action items, risks, owners…"
              disabled={chatLoading}
              className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={chatLoading || !chatInput.trim()}
              className="h-9 w-9 grid place-items-center rounded-md bg-foreground text-background disabled:opacity-40"
              aria-label="Send"
              title="Send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function initialsFromName(name: string) {
  const parts = name.trim().split(/\\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function clockFromIso(iso: string) {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function istClockFromIso(iso: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

function istDateTimeFromIso(iso: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

function notesToPlainText(md: string) {
  return String(md)
    .split("\\n")
    .map((line) => {
      const t = line.trimEnd();
      if (/^#{1,6}\\s+/.test(t)) return t.replace(/^#{1,6}\\s+/, "").trim();
      if (/^[-*]\\s+/.test(t)) return t.replace(/^[-*]\\s+/, "• ").trim();
      return t;
    })
    .join("\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}

