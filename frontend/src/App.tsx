import { useCallback, useEffect, useRef, useState } from "react";

const OP_HOTKEYS: Record<string, { intent: string }> = {
  s: { intent: "split this graf at the natural sentence boundary" },
  m: { intent: "merge these grafs; collapse any redundancy with minimal glue" },
  h: { intent: "hoist this graf to thesis or intro position; reorder context to follow" },
  j: { intent: "demote this graf under its parent claim" },
  b: { intent: "move this graf — find the better position for it in the argument flow" },
};

import { Editor, type EditorHandle } from "@/components/Editor";
import { CommandPalette } from "@/components/CommandPalette";
import { DiffOverlay } from "@/components/DiffOverlay";
import { Panopticon } from "@/components/Panopticon";
import { StatusBar } from "@/components/StatusBar";
import { useSession } from "@/store/session";
import { decide, getHealth, getProfile, inspect, propose } from "@/lib/api";
import { applyOperators } from "@/lib/operators";
import type { AlfredDocument } from "@/lib/types";

export function App() {
  const editorRef = useRef<EditorHandle | null>(null);
  const proposeAbort = useRef<AbortController | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recentIntents, setRecentIntents] = useState<string[]>([]);
  const [originalAtPropose, setOriginalAtPropose] = useState<AlfredDocument | null>(null);
  const [intentAtPropose, setIntentAtPropose] = useState<string>("");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  const {
    sessionId,
    status,
    pendingProposal,
    panopticonOpen,
    setStatus,
    setProposal,
    setProfile,
    setInspectRead,
    togglePanopticon,
    pushDecision,
  } = useSession();

  // backend health check on mount, then periodic re-check while offline
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const h = await getHealth();
      if (!alive) return;
      setBackendOnline(h.ok);
    };
    void ping();
    const id = setInterval(() => {
      if (!alive) return;
      if (backendOnline === false) void ping();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [backendOnline]);

  // global hotkeys
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      if (e.key === "k" || e.key === "K") {
        if (status === "diff") return; // diff overlay owns the keys
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === ".") {
        e.preventDefault();
        togglePanopticon();
        return;
      }
      if (e.key === "i" || e.key === "I") {
        if (status === "diff") return;
        e.preventDefault();
        await runInspect();
        return;
      }
      // global Esc cancels any in-flight propose if no diff is open
      if (e.key === "Escape" && status === "thinking") {
        e.preventDefault();
        proposeAbort.current?.abort();
        proposeAbort.current = null;
        setStatus("ready", "cancelled");
        setTimeout(() => useSession.getState().setStatus("ready"), 1500);
        return;
      }
      // operator-specific hotkeys: read selection from editor and submit a focused intent
      if (status === "diff" || status === "thinking") return;
      const selection = editorRef.current?.getSelectedParagraphIds() ?? [];
      const opHotkey = OP_HOTKEYS[e.key.toLowerCase()];
      if (opHotkey && selection.length > 0) {
        e.preventDefault();
        await submitIntent(opHotkey.intent, { paragraph_ids: selection });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, togglePanopticon]);

  // load demo content if user pastes via "demo" buttons
  const loadDemo = useCallback(async (which: "draft-1" | "draft-2") => {
    if (!editorRef.current) return;
    try {
      const res = await fetch(`/demo/${which}.md`);
      const md = await res.text();
      editorRef.current.loadMarkdown(md);
      editorRef.current.focus();
    } catch (err) {
      console.error("load demo failed", err);
    }
  }, []);

  const runInspect = useCallback(async () => {
    if (!editorRef.current) return;
    const doc = editorRef.current.getDocument();
    setStatus("thinking", "reading the document");
    try {
      const r = await inspect({ document: doc, session_id: sessionId });
      setInspectRead({
        read: r.read,
        claims: r.claims,
        evidence_links: r.evidence_links,
        orphans: r.orphans,
      });
      useSession.getState().setStatus("ready");
      if (!useSession.getState().panopticonOpen) {
        useSession.getState().togglePanopticon();
      }
      useSession.getState().setPanopticonTab("read");
    } catch (err) {
      console.error(err);
      setStatus("error", String(err));
    }
  }, [sessionId, setInspectRead, setStatus]);

  const submitIntent = useCallback(
    async (intent: string, selection?: { paragraph_ids: string[] }) => {
      if (!editorRef.current) return;
      const doc = editorRef.current.getDocument();
      setOriginalAtPropose(doc);
      setIntentAtPropose(intent);
      setRecentIntents((prev) => [intent, ...prev.filter((p) => p !== intent)].slice(0, 6));
      setPaletteOpen(false);
      setStatus("thinking", "running operator algebra");
      const controller = new AbortController();
      proposeAbort.current = controller;
      try {
        const r = await propose({
          document: doc,
          intent,
          session_id: sessionId,
          ...(selection && selection.paragraph_ids.length > 0 ? { selection } : {}),
        });
        if (controller.signal.aborted) return;
        if (r.ok) {
          setProposal(r.proposal);
        } else {
          console.error("propose error", r);
          setStatus("error", r.error);
          setTimeout(() => setStatus("ready"), 2500);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error(err);
        setStatus("error", String(err));
        setTimeout(() => setStatus("ready"), 2500);
      } finally {
        if (proposeAbort.current === controller) proposeAbort.current = null;
      }
    },
    [sessionId, setProposal, setStatus]
  );

  const onAccept = useCallback(async () => {
    if (!pendingProposal || !editorRef.current || !originalAtPropose) return;
    const next = applyOperators(originalAtPropose, pendingProposal.operators);
    editorRef.current.setDocument(next);
    pushDecision({
      ts: new Date().toISOString(),
      intent: intentAtPropose || "—",
      decision: "accept",
      rationale: pendingProposal.rationale,
      operator_kinds: pendingProposal.operators.map((o) => o.kind),
    });
    try {
      await decide({
        session_id: sessionId,
        proposal_id: pendingProposal.id,
        decision: "accept",
      });
      getProfile().then((r) => setProfile(r.profile)).catch(() => {});
    } catch (err) {
      console.error("decide accept failed", err);
    }
    setProposal(null);
    setStatus("ready", "+1 accepted");
    setTimeout(() => setStatus("ready"), 1800);
  }, [pendingProposal, originalAtPropose, pushDecision, sessionId, setProposal, setProfile, setStatus]);

  const onAlternative = useCallback(async () => {
    if (!pendingProposal) return;
    const previousIntent = intentAtPropose;
    pushDecision({
      ts: new Date().toISOString(),
      intent: previousIntent || "—",
      decision: "reject",
      rationale: pendingProposal.rationale,
      operator_kinds: pendingProposal.operators.map((o) => o.kind),
    });
    try {
      await decide({
        session_id: sessionId,
        proposal_id: pendingProposal.id,
        decision: "reject",
        reject_reason: "asked for alternative",
      });
      getProfile().then((r) => setProfile(r.profile)).catch(() => {});
    } catch (err) {
      console.error("decide reject failed", err);
    }
    setProposal(null);
    setStatus("ready", "asking for alternative");
    // resubmit with same intent + a hint to try a different angle
    if (previousIntent) {
      await submitIntent(`${previousIntent} — try a different angle than the previous proposal`);
    } else {
      setPaletteOpen(true);
    }
  }, [pendingProposal, intentAtPropose, sessionId, pushDecision, setProposal, setProfile, setStatus]);

  const onReject = useCallback(
    async (reason?: string) => {
      if (!pendingProposal) return;
      pushDecision({
        ts: new Date().toISOString(),
        intent: intentAtPropose || "—",
        decision: "reject",
        rationale: pendingProposal.rationale,
        operator_kinds: pendingProposal.operators.map((o) => o.kind),
      });
      try {
        await decide({
          session_id: sessionId,
          proposal_id: pendingProposal.id,
          decision: "reject",
          reject_reason: reason,
        });
        getProfile().then((r) => setProfile(r.profile)).catch(() => {});
      } catch (err) {
        console.error("decide reject failed", err);
      }
      setProposal(null);
      setStatus("ready", "rejected");
      setTimeout(() => setStatus("ready"), 1800);
    },
    [pendingProposal, pushDecision, sessionId, setProposal, setProfile, setStatus]
  );

  return (
    <div className="min-h-screen bg-paper text-ink">
      <Header onLoadDemo={loadDemo} onOpenPanopticon={togglePanopticon} onInspect={runInspect} />
      {backendOnline === false && <BackendOfflineBanner />}

      <main
        style={{
          paddingRight: panopticonOpen ? 440 : 0,
          transition: "padding-right 220ms ease",
        }}
      >
        <div style={{ display: pendingProposal ? "none" : "block" }}>
          <Editor onReady={(h) => (editorRef.current = h)} diffMode={Boolean(pendingProposal)} />
        </div>
        {pendingProposal && originalAtPropose && (
          <DiffOverlay
            originalDoc={originalAtPropose}
            proposal={pendingProposal}
            onAccept={onAccept}
            onReject={onReject}
            onAlternative={onAlternative}
          />
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSubmit={submitIntent}
        recent={recentIntents}
      />

      {panopticonOpen && <Panopticon onClose={togglePanopticon} />}
      <StatusBar />
    </div>
  );
}

function BackendOfflineBanner() {
  return (
    <div className="bg-accent/10 border-b border-accent/30 text-accent font-sans text-[12px] py-2 px-6 text-center">
      <span className="font-medium">Alfred backend is offline.</span> Run{" "}
      <code className="bg-accent/10 px-1 py-0.5 rounded text-[11px]">npm run dev:backend</code> in another terminal, then refresh.
      The backend serves <code className="bg-accent/10 px-1 py-0.5 rounded text-[11px]">claude-opus-4-7</code> on{" "}
      <code className="bg-accent/10 px-1 py-0.5 rounded text-[11px]">localhost:3001</code>; check that
      <code className="bg-accent/10 px-1 py-0.5 rounded text-[11px] ml-1">ANTHROPIC_API_KEY</code> is set.
    </div>
  );
}

function Header({
  onLoadDemo,
  onOpenPanopticon,
  onInspect,
}: {
  onLoadDemo: (which: "draft-1" | "draft-2") => void;
  onOpenPanopticon: () => void;
  onInspect: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 backdrop-blur bg-paper/85 border-b border-rule">
      <div className="px-6 py-3 flex items-center justify-between font-sans text-[12px] text-muted">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="tracking-[0.3em] uppercase text-[10px] text-ink/80 whitespace-nowrap">Alfred</span>
          <span className="text-[11px] italic opacity-70 hidden lg:inline whitespace-nowrap truncate">
            inverse-whitewashing · structure-only · voice preserved by construction
          </span>
        </div>
        <nav className="flex items-center gap-3 whitespace-nowrap">
          <button
            onClick={() => onLoadDemo("draft-1")}
            className="hover:text-ink transition-colors whitespace-nowrap"
            title="Load demo: messy 600-word essay"
          >
            demo · essay
          </button>
          <button
            onClick={() => onLoadDemo("draft-2")}
            className="hover:text-ink transition-colors whitespace-nowrap"
            title="Load demo: Skyfall multi-source"
          >
            demo · skyfall
          </button>
          <span className="text-rule">·</span>
          <button
            onClick={onInspect}
            className="hover:text-ink transition-colors"
            title="Cmd+I — let Alfred read the document"
          >
            inspect
          </button>
          <button
            onClick={onOpenPanopticon}
            className="hover:text-ink transition-colors"
            title="Cmd+. — Panopticon"
          >
            panopticon
          </button>
          <span className="text-rule">·</span>
          <kbd className="text-[10px] uppercase tracking-widest opacity-60 bg-chrome px-1.5 py-0.5 rounded">cmd+k</kbd>
        </nav>
      </div>
    </header>
  );
}
