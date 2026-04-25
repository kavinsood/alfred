import { useEffect, useState } from "react";
import { X, Eye, Settings, History } from "lucide-react";
import { useSession } from "@/store/session";
import { getProfile, putProfile } from "@/lib/api";
import type { VoiceProfile } from "@/lib/types";

type Props = {
  onClose: () => void;
};

export function Panopticon({ onClose }: Props) {
  const { panopticonTab, setPanopticonTab, profile, setProfile, recentDecisions, inspectRead } = useSession();
  const [draftAnchor, setDraftAnchor] = useState("");
  const [draftTokens, setDraftTokens] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const r = await getProfile();
        if (!active) return;
        setProfile(r.profile);
        setDraftAnchor(r.profile.vibe_anchor);
        setDraftTokens(r.profile.forbidden_tokens.join("\n"));
      } catch {
        // ignore
      }
    })();
    return () => {
      active = false;
    };
  }, [setProfile]);

  const persist = async () => {
    if (!profile) return;
    const next: VoiceProfile = {
      ...profile,
      vibe_anchor: draftAnchor.trim(),
      forbidden_tokens: draftTokens.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    };
    setSaving(true);
    try {
      await putProfile(next);
      setProfile(next);
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="fixed top-0 right-0 z-40 h-full w-[440px] bg-paper border-l border-rule shadow-xl flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-rule">
        <div className="font-sans text-[11px] uppercase tracking-widest text-muted">Panopticon</div>
        <button onClick={onClose} className="p-1 text-muted hover:text-ink">
          <X size={16} />
        </button>
      </header>

      <nav className="flex border-b border-rule font-sans text-[12px]">
        <TabButton
          icon={<Eye size={13} />}
          label="Read"
          active={panopticonTab === "read"}
          onClick={() => setPanopticonTab("read")}
        />
        <TabButton
          icon={<Settings size={13} />}
          label="Profile"
          active={panopticonTab === "profile"}
          onClick={() => setPanopticonTab("profile")}
        />
        <TabButton
          icon={<History size={13} />}
          label="Log"
          active={panopticonTab === "log"}
          onClick={() => setPanopticonTab("log")}
        />
      </nav>

      <div className="flex-1 overflow-y-auto">
        {panopticonTab === "read" && (
          <ReadTab inspect={inspectRead} />
        )}
        {panopticonTab === "profile" && (
          <ProfileTab
            profile={profile}
            draftAnchor={draftAnchor}
            setDraftAnchor={setDraftAnchor}
            draftTokens={draftTokens}
            setDraftTokens={setDraftTokens}
            onSave={persist}
            saving={saving}
            savedAt={savedAt}
          />
        )}
        {panopticonTab === "log" && (
          <LogTab entries={recentDecisions} />
        )}
      </div>
    </aside>
  );
}

function TabButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 ${active ? "text-ink border-b-2 border-ink -mb-px" : "text-muted hover:text-ink/70"}`}
    >
      {icon}
      {label}
    </button>
  );
}

function ReadTab({ inspect }: { inspect: { read: string; claims: number; evidence_links: number; orphans: string[] } | null }) {
  if (!inspect) {
    return (
      <div className="px-5 py-6 font-sans text-[13px] text-muted">
        <p>Hit <kbd className="px-1.5 py-0.5 bg-chrome rounded text-ink">Cmd+I</kbd> to ask Alfred to read your document.</p>
      </div>
    );
  }
  return (
    <div className="px-5 py-5 font-sans text-[13px] space-y-4">
      <div>
        <div className="text-[11px] uppercase tracking-widest text-muted mb-2">What I see</div>
        <p className="text-ink leading-relaxed">{inspect.read}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Claims" value={inspect.claims} />
        <Stat label="Evidence" value={inspect.evidence_links} />
        <Stat label="Orphans" value={inspect.orphans.length} />
      </div>
      {inspect.orphans.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-widest text-muted mb-2">Orphan paragraphs</div>
          <ul className="text-[12px] text-muted space-y-1">
            {inspect.orphans.map((id, i) => (
              <li key={i} className="font-mono">{id.slice(0, 8)}…</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-chrome rounded px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-[18px] font-medium text-ink">{value}</div>
    </div>
  );
}

function ProfileTab({
  profile,
  draftAnchor,
  setDraftAnchor,
  draftTokens,
  setDraftTokens,
  onSave,
  saving,
  savedAt,
}: {
  profile: VoiceProfile | null;
  draftAnchor: string;
  setDraftAnchor: (v: string) => void;
  draftTokens: string;
  setDraftTokens: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  savedAt: string | null;
}) {
  if (!profile) {
    return <div className="px-5 py-6 font-sans text-[13px] text-muted">Loading profile…</div>;
  }
  return (
    <div className="px-5 py-5 font-sans text-[13px] space-y-5">
      <div>
        <div className="text-[11px] uppercase tracking-widest text-muted mb-2">vibe_anchor</div>
        <textarea
          value={draftAnchor}
          onChange={(e) => setDraftAnchor(e.target.value)}
          rows={6}
          placeholder="Paste 2-3 paragraphs of writing that sounds like you at your best."
          className="w-full bg-chrome rounded p-3 text-[13px] font-serif resize-y border border-rule focus:border-ink/30 focus:outline-none"
        />
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-widest text-muted mb-2">forbidden_tokens</div>
        <textarea
          value={draftTokens}
          onChange={(e) => setDraftTokens(e.target.value)}
          rows={6}
          placeholder="One per line."
          className="w-full bg-chrome rounded p-3 text-[12px] font-mono resize-y border border-rule focus:border-ink/30 focus:outline-none"
        />
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-widest text-muted mb-2">
          learned_preferences ({profile.learned_preferences.length})
        </div>
        {profile.learned_preferences.length === 0 ? (
          <p className="text-[12px] text-muted italic">Nothing learned yet — Alfred populates this from your accept/reject decisions.</p>
        ) : (
          <ul className="space-y-2">
            {profile.learned_preferences.map((p) => (
              <li key={p.id} className="bg-chrome rounded p-3">
                <div className="text-ink leading-snug">{p.rule}</div>
                <div className="text-[11px] text-muted mt-1">×{p.evidence_count} · {new Date(p.inferred_at).toLocaleDateString()}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-rule">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-1.5 rounded bg-ink text-paper text-[12px] font-medium disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
        {savedAt && <span className="text-[11px] text-muted">Saved at {savedAt}</span>}
      </div>
    </div>
  );
}

function LogTab({ entries }: { entries: Array<{ ts: string; intent: string; decision: string; rationale: string; operator_kinds: string[] }> }) {
  if (entries.length === 0) {
    return <div className="px-5 py-6 font-sans text-[13px] text-muted italic">No decisions yet this session.</div>;
  }
  const accepted = entries.filter((e) => e.decision === "accept").length;
  const rejected = entries.filter((e) => e.decision === "reject").length;
  const modified = entries.filter((e) => e.decision === "modify").length;
  const total = entries.length;
  const rate = total > 0 ? Math.round((accepted / total) * 100) : 0;
  const opTotals = entries
    .flatMap((e) => e.operator_kinds)
    .reduce<Record<string, number>>((acc, k) => {
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const opSummary = Object.entries(opTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ");
  return (
    <div className="px-5 py-5 font-sans text-[13px] space-y-3">
      <div className="bg-chrome rounded p-3 space-y-1">
        <div className="text-[11px] uppercase tracking-widest text-muted">Session</div>
        <div className="text-ink leading-snug">
          <span className="font-medium tabular-nums">{total}</span> proposal{total === 1 ? "" : "s"}
          {" · "}
          <span className="text-[#2d5a2d] tabular-nums">{accepted} accept</span>
          {" · "}
          <span className="text-accent tabular-nums">{rejected} reject</span>
          {modified > 0 ? ` · ${modified} modify` : ""}
          {total > 0 ? ` · ${rate}% accept rate` : ""}
        </div>
        {opSummary && (
          <div className="text-[11px] text-muted">operators: {opSummary}</div>
        )}
      </div>
      {entries.slice().reverse().map((e, i) => (
        <div key={i} className="border-b border-rule pb-3 last:border-b-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest mb-1">
            <span className={e.decision === "accept" ? "text-[#2d5a2d]" : e.decision === "reject" ? "text-accent" : "text-muted"}>
              {e.decision}
            </span>
            <span className="text-muted">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className="text-muted">· {e.operator_kinds.join(", ")}</span>
          </div>
          <div className="text-ink leading-snug">{e.intent}</div>
          <div className="text-[12px] text-muted italic mt-1">{e.rationale}</div>
        </div>
      ))}
    </div>
  );
}
