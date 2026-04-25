import { useSession } from "@/store/session";

export function StatusBar() {
  const { status, statusDetail } = useSession();

  const label =
    status === "thinking" ? "Alfred is reading…" :
    status === "diff" ? "Reviewing proposal" :
    status === "error" ? "Alfred error" :
    "Alfred ready";

  const dotColor =
    status === "thinking" ? "bg-amber-500" :
    status === "diff" ? "bg-emerald-600" :
    status === "error" ? "bg-accent" :
    "bg-muted";

  return (
    <div className="fixed bottom-3 right-4 z-30 flex items-center gap-2 font-sans text-[11px] text-muted bg-paper/80 backdrop-blur px-3 py-1.5 rounded-full border border-rule">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor} ${status === "thinking" ? "animate-pulse" : ""}`} />
      <span>{label}{statusDetail ? ` · ${statusDetail}` : ""}</span>
    </div>
  );
}
