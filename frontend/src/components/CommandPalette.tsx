import { useEffect, useRef, useState } from "react";
import { useSession } from "@/store/session";

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (intent: string) => void;
  recent: string[];
};

const RECENT_DEFAULTS = [
  "this graf drags",
  "where does this repeat?",
  "buried thesis — find it",
  "kill the weakest aside",
  "unify these into one argument",
  "tighten this section",
];

export function CommandPalette({ open, onClose, onSubmit, recent }: Props) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const status = useSession((s) => s.status);

  useEffect(() => {
    if (!open) return;
    setValue("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
  };

  const suggestions = [...recent, ...RECENT_DEFAULTS.filter((d) => !recent.includes(d))].slice(0, 6);

  return (
    <div
      className="alfred-cmdk-backdrop fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-xl bg-white shadow-2xl ring-1 ring-black/5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2 flex items-center gap-2">
          <span className="font-sans text-[11px] uppercase tracking-widest text-muted">
            {status === "thinking" ? "Alfred is reading…" : "Tell Alfred what to do"}
          </span>
        </div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder='e.g., "this graf drags" or "split here"'
          className="w-full px-4 py-3 text-[16px] font-sans bg-transparent outline-none border-y border-rule"
          disabled={status === "thinking"}
        />
        <div className="px-2 py-2 max-h-[280px] overflow-y-auto bg-chrome/40">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setValue(s);
                setTimeout(submit, 0);
              }}
              className="block w-full text-left px-3 py-2 rounded font-sans text-[14px] text-ink/80 hover:bg-paper hover:text-ink"
            >
              {s}
            </button>
          ))}
        </div>
        <div className="px-4 py-2 text-[11px] font-sans text-muted flex justify-between">
          <span>Enter to submit · Esc to dismiss</span>
          <span className="opacity-60">Alfred can only move text, not write it.</span>
        </div>
      </div>
    </div>
  );
}
