import { useCallback, useEffect, useRef, useState } from "react";
import { Editor, type EditorHandle } from "@/components/Editor";
import { CommandPalette } from "@/components/CommandPalette";
import { DiffOverlay } from "@/components/DiffOverlay";
import { Panopticon } from "@/components/Panopticon";
import { StatusBar } from "@/components/StatusBar";
import { useSession } from "@/store/session";
import { decide, inspect, propose } from "@/lib/api";
import { applyOperators } from "@/lib/operators";
import type { AlfredDocument } from "@/lib/types";

export function App() {
  const editorRef = useRef<EditorHandle | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recentIntents, setRecentIntents] = useState<string[]>([]);
  const [originalAtPropose, setOriginalAtPropose] = useState<AlfredDocument | null>(null);

  const {
    sessionId,
    status,
    pendingProposal,
    panopticonOpen,
    setStatus,
    setProposal,
    setInspectRead,
    togglePanopticon,
    pushDecision,
  } = useSession();

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
    async (intent: string) => {
      if (!editorRef.current) return;
      const doc = editorRef.current.getDocument();
      setOriginalAtPropose(doc);
      setRecentIntents((prev) => [intent, ...prev.filter((p) => p !== intent)].slice(0, 6));
      setPaletteOpen(false);
      setStatus("thinking", "running operator algebra");
      try {
        const r = await propose({
          document: doc,
          intent,
          session_id: sessionId,
        });
        if (r.ok) {
          setProposal(r.proposal);
        } else {
          console.error("propose error", r);
          setStatus("error", r.error);
          setTimeout(() => setStatus("ready"), 2500);
        }
      } catch (err) {
        console.error(err);
        setStatus("error", String(err));
        setTimeout(() => setStatus("ready"), 2500);
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
      intent: useSession.getState().alfredSays.length > 0 ? useSession.getState().alfredSays : "—",
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
    } catch (err) {
      console.error("decide accept failed", err);
    }
    setProposal(null);
    setStatus("ready", "+1 accepted");
    setTimeout(() => setStatus("ready"), 1800);
  }, [pendingProposal, originalAtPropose, pushDecision, sessionId, setProposal, setStatus]);

  const onReject = useCallback(
    async (reason?: string) => {
      if (!pendingProposal) return;
      pushDecision({
        ts: new Date().toISOString(),
        intent: useSession.getState().alfredSays.length > 0 ? useSession.getState().alfredSays : "—",
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
      } catch (err) {
        console.error("decide reject failed", err);
      }
      setProposal(null);
      setStatus("ready", "rejected");
      setTimeout(() => setStatus("ready"), 1800);
    },
    [pendingProposal, pushDecision, sessionId, setProposal, setStatus]
  );

  return (
    <div className="min-h-screen bg-paper text-ink">
      <Header onLoadDemo={loadDemo} onOpenPanopticon={togglePanopticon} />

      <main
        style={{
          paddingRight: panopticonOpen ? 440 : 0,
          transition: "padding-right 220ms ease",
        }}
      >
        {pendingProposal && originalAtPropose ? (
          <DiffOverlay
            originalDoc={originalAtPropose}
            proposal={pendingProposal}
            onAccept={onAccept}
            onReject={onReject}
          />
        ) : (
          <Editor onReady={(h) => (editorRef.current = h)} diffMode={false} />
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

function Header({
  onLoadDemo,
  onOpenPanopticon,
}: {
  onLoadDemo: (which: "draft-1" | "draft-2") => void;
  onOpenPanopticon: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 backdrop-blur bg-paper/85 border-b border-rule">
      <div className="max-w-prose mx-auto px-12 py-3 flex items-center justify-between font-sans text-[12px] text-muted">
        <span className="tracking-[0.3em] uppercase text-[10px]">Alfred</span>
        <nav className="flex items-center gap-3">
          <button
            onClick={() => onLoadDemo("draft-1")}
            className="hover:text-ink transition-colors"
            title="Load demo: messy 600-word essay"
          >
            demo · essay
          </button>
          <button
            onClick={() => onLoadDemo("draft-2")}
            className="hover:text-ink transition-colors"
            title="Load demo: Skyfall multi-source"
          >
            demo · skyfall
          </button>
          <span className="text-rule">·</span>
          <button
            onClick={onOpenPanopticon}
            className="hover:text-ink transition-colors"
            title="Cmd+."
          >
            panopticon
          </button>
          <span className="text-rule">·</span>
          <span className="text-[10px] uppercase tracking-widest opacity-60">cmd+k</span>
        </nav>
      </div>
    </header>
  );
}
