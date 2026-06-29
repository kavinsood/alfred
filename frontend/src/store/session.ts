import { create } from "zustand";
import type { AlfredDocument, Proposal, VoiceProfile } from "@/lib/types";
import { randomId } from "@/lib/operators";

export type AlfredStatus = "ready" | "thinking" | "diff" | "error";

type SessionState = {
  sessionId: string;
  status: AlfredStatus;
  statusDetail: string;
  /** ms timestamp when the current status was set; used to show elapsed time during "thinking" */
  statusStartedAt: number;
  alfredSays: string;
  pendingProposal: Proposal | null;
  panopticonOpen: boolean;
  panopticonTab: "read" | "profile" | "log" | "environment";
  profile: VoiceProfile | null;
  recentDecisions: Array<{ ts: string; intent: string; decision: string; rationale: string; operator_kinds: string[] }>;
  inspectRead: { read: string; claims: number; evidence_links: number; orphans: string[] } | null;
  setStatus: (s: AlfredStatus, detail?: string) => void;
  setProposal: (p: Proposal | null) => void;
  setProfile: (p: VoiceProfile | null) => void;
  setInspectRead: (r: SessionState["inspectRead"]) => void;
  setAlfredSays: (s: string) => void;
  togglePanopticon: () => void;
  setPanopticonTab: (t: SessionState["panopticonTab"]) => void;
  pushDecision: (entry: SessionState["recentDecisions"][number]) => void;
  resetSession: () => void;
};

export const useSession = create<SessionState>((set) => ({
  sessionId: randomId(),
  status: "ready",
  statusDetail: "",
  statusStartedAt: Date.now(),
  alfredSays: "",
  pendingProposal: null,
  panopticonOpen: false,
  panopticonTab: "read",
  profile: null,
  recentDecisions: [],
  inspectRead: null,
  setStatus: (status, statusDetail = "") => set({ status, statusDetail, statusStartedAt: Date.now() }),
  setProposal: (pendingProposal) =>
    set({
      pendingProposal,
      status: pendingProposal ? "diff" : "ready",
      alfredSays: pendingProposal ? pendingProposal.alfred_says : "",
    }),
  setProfile: (profile) => set({ profile }),
  setInspectRead: (inspectRead) => set({ inspectRead }),
  setAlfredSays: (alfredSays) => set({ alfredSays }),
  togglePanopticon: () => set((s) => ({ panopticonOpen: !s.panopticonOpen })),
  setPanopticonTab: (panopticonTab) => set({ panopticonTab }),
  pushDecision: (entry) => set((s) => ({ recentDecisions: [...s.recentDecisions, entry].slice(-50) })),
  resetSession: () => set({ sessionId: randomId(), pendingProposal: null, alfredSays: "", status: "ready" }),
}));
