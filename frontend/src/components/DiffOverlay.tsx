import { useEffect, useMemo, useState } from "react";
import { applyOperators, describeOperator, splitSentences } from "@/lib/operators";
import type { AlfredDocument, Operator, Paragraph, Proposal } from "@/lib/types";

type Props = {
  originalDoc: AlfredDocument;
  proposal: Proposal;
  onAccept: () => void;
  onReject: (reason?: string) => void;
  onAlternative: () => void;
};

// Build a presentation model: for each paragraph we tag what's happening.
type Annotation =
  | { kind: "intact" }
  | { kind: "split-marker"; sentenceIndex: number }
  | { kind: "merge-source"; intoFirstId: string; glue?: string }
  | { kind: "merge-target"; absorbsId: string; glue?: string }
  | { kind: "move-source"; targetDescription: string; role?: string }
  | { kind: "demote-source"; parentDescription: string }
  | { kind: "migrate"; oldText: string; newText: string; changeBudget: number }
  | { kind: "delete" };

type InsertedGlue = { afterId: string | null; atStartOfId?: string; text: string };

export function DiffOverlay({ originalDoc, proposal, onAccept, onReject, onAlternative }: Props) {
  const annotations = useMemo(
    () => buildAnnotations(originalDoc, proposal.operators),
    [originalDoc, proposal]
  );
  const projectedDoc = useMemo(
    () => applyOperators(originalDoc, proposal.operators),
    [originalDoc, proposal]
  );
  const [showProjected, setShowProjected] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault();
        onAccept();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onReject();
        return;
      }
      // Cmd+Shift+K asks Alfred for an alternative
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        onAlternative();
        return;
      }
      // P toggles the projected-document preview (only when no modifier is held)
      if ((e.key === "p" || e.key === "P") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShowProjected((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAccept, onReject, onAlternative]);

  return (
    <div className="alfred-prose px-12 py-16 max-w-prose mx-auto">
      <DiffHeader
        proposal={proposal}
        idLabel={annotations.idLabel}
        showProjected={showProjected}
        onToggleProjected={() => setShowProjected((v) => !v)}
      />

      {showProjected ? (
        <ProjectedView doc={projectedDoc} />
      ) : (
        <>
          {originalDoc.paragraphs.map((p) => {
            const ann = annotations.get(p.id) ?? { kind: "intact" as const };
            const glueBefore = annotations.glueAtStart.get(p.id);
            const glueAfter = annotations.glueAfter.get(p.id);
            return (
              <div key={p.id}>
                {glueBefore ? <GlueLine text={glueBefore} /> : null}
                <ParagraphView para={p} annotation={ann} idMap={annotations.idLabel} />
                {glueAfter ? <GlueLine text={glueAfter} /> : null}
              </div>
            );
          })}
          {annotations.glueAtEnd ? <GlueLine text={annotations.glueAtEnd} /> : null}
        </>
      )}

      <DiffFooter onAccept={onAccept} onReject={() => onReject()} onAlternative={onAlternative} />
    </div>
  );
}

function DiffHeader({
  proposal,
  idLabel,
  showProjected,
  onToggleProjected,
}: {
  proposal: Proposal;
  idLabel: Map<string, string>;
  showProjected: boolean;
  onToggleProjected: () => void;
}) {
  return (
    <div className="font-sans text-[13px] mb-8 pb-4 border-b border-rule">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-widest text-muted">
          Alfred proposes {showProjected && "— previewing projected document"}
        </div>
        <button
          onClick={onToggleProjected}
          className="text-[11px] uppercase tracking-widest text-muted hover:text-ink transition-colors"
          title="Toggle preview (P)"
        >
          {showProjected ? "show diff" : "preview"} <kbd className="ml-1 px-1.5 py-0.5 rounded bg-chrome text-ink text-[10px]">P</kbd>
        </button>
      </div>
      <div className="text-ink text-[16px] leading-snug font-serif italic">
        {proposal.alfred_says}
      </div>
      <div className="mt-2 text-muted text-[12px]">
        {proposal.rationale}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {proposal.operators.map((op, i) => (
          <span
            key={i}
            className="inline-block text-[11px] uppercase tracking-wider rounded px-2 py-0.5 bg-chrome text-muted"
          >
            {describeOperator(op, idLabel)}
          </span>
        ))}
        {proposal.operators.length === 0 && (
          <span className="italic text-muted text-[12px]">
            No structural changes — Alfred says: leave it.
          </span>
        )}
      </div>
      <VoiceIntegrityBadge proposal={proposal} />
    </div>
  );
}

function DiffFooter({
  onAccept,
  onReject,
  onAlternative,
}: {
  onAccept: () => void;
  onReject: () => void;
  onAlternative: () => void;
}) {
  return (
    <div className="font-sans text-[12px] mt-12 pt-4 border-t border-rule flex items-center justify-between text-muted">
      <span>
        <kbd className="px-1.5 py-0.5 rounded bg-chrome text-ink">Tab</kbd> accept ·{" "}
        <kbd className="px-1.5 py-0.5 rounded bg-chrome text-ink">Esc</kbd> reject ·{" "}
        <kbd className="px-1.5 py-0.5 rounded bg-chrome text-ink">⇧⌘K</kbd> alternative ·{" "}
        <kbd className="px-1.5 py-0.5 rounded bg-chrome text-ink">P</kbd> preview
      </span>
      <span className="space-x-3">
        <button onClick={onAlternative} className="px-3 py-1.5 rounded text-ink/70 hover:text-ink">
          Alternative
        </button>
        <button onClick={onReject} className="px-3 py-1.5 rounded text-ink/70 hover:text-ink">
          Reject
        </button>
        <button onClick={onAccept} className="px-4 py-1.5 rounded bg-ink text-paper font-medium">
          Accept
        </button>
      </span>
    </div>
  );
}

function ParagraphView({
  para,
  annotation,
  idMap,
}: {
  para: Paragraph;
  annotation: Annotation;
  idMap: Map<string, string>;
}) {
  if (annotation.kind === "intact") {
    return <p>{para.text}</p>;
  }
  if (annotation.kind === "delete") {
    return (
      <p className="diff-deleted">
        <span className="role-tag text-accent">Delete</span>
        {para.text}
      </p>
    );
  }
  if (annotation.kind === "migrate") {
    return (
      <p>
        <span className="role-tag text-accent">Migrate · Δ{annotation.changeBudget} tokens</span>
        <span className="diff-migrate-old">{annotation.oldText}</span>
        <span className="diff-migrate-new">{annotation.newText}</span>
      </p>
    );
  }
  if (annotation.kind === "split-marker") {
    const sentences = splitSentences(para.text);
    const firstHalf = sentences.slice(0, annotation.sentenceIndex + 1).join(" ");
    const secondHalf = sentences.slice(annotation.sentenceIndex + 1).join(" ");
    return (
      <>
        <p>
          <span className="role-tag">Split here ↓</span>
          {firstHalf}
        </p>
        <div className="my-3 h-[1px] bg-accent/40" />
        <p>{secondHalf}</p>
      </>
    );
  }
  if (annotation.kind === "merge-source") {
    return (
      <p className="diff-moved-source">
        <span className="role-tag text-accent">Will merge into the previous graf{annotation.glue ? " — glue: " + annotation.glue : ""}</span>
        {para.text}
      </p>
    );
  }
  if (annotation.kind === "merge-target") {
    return (
      <p className="diff-moved-target">
        <span className="role-tag">Absorbs the next graf{annotation.glue ? " · glue: " + annotation.glue : ""}</span>
        {para.text}
      </p>
    );
  }
  if (annotation.kind === "move-source") {
    return (
      <p className="diff-moved-source">
        <span className="role-tag text-accent">
          {annotation.role ? `Hoist as ${annotation.role} → ` : "Move → "}
          {annotation.targetDescription}
        </span>
        {para.text}
      </p>
    );
  }
  if (annotation.kind === "demote-source") {
    return (
      <p style={{ paddingLeft: "1.25em", borderLeft: "2px solid #e7e1d4" }}>
        <span className="role-tag">Demote under: {annotation.parentDescription}</span>
        {para.text}
      </p>
    );
  }
  return <p>{para.text}</p>;
}

function VoiceIntegrityBadge({ proposal }: { proposal: Proposal }) {
  const ops = proposal.operators;
  const total = ops.length;
  if (total === 0) return null;
  const structural = ops.filter((o) =>
    ["split", "merge", "move", "hoist", "demote", "delete"].includes(o.kind)
  ).length;
  const generative = ops.filter((o) => o.kind === "glue" || o.kind === "migrate").length;
  const glueTokens = proposal.voice_check.glue_budget_used;
  const migratePct = proposal.voice_check.migrate_change_pct;
  const allStructural = generative === 0;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] font-sans">
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${
          allStructural
            ? "border-[#2d5a2d]/40 text-[#2d5a2d] bg-[#2d5a2d]/5"
            : "border-rule text-muted bg-chrome"
        }`}
      >
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            allStructural ? "bg-[#2d5a2d]" : "bg-amber-500"
          }`}
        />
        Voice integrity
      </span>
      <span className="text-muted tabular-nums">
        {structural} structural · {generative} generative
      </span>
      <span className="text-muted tabular-nums">
        glue {glueTokens}/60 tok
      </span>
      {migratePct !== null && (
        <span className="text-muted tabular-nums">
          migrate Δ{(migratePct * 100).toFixed(0)}% / 50% cap
        </span>
      )}
      {allStructural && glueTokens === 0 && (
        <span className="italic text-muted">— pure structural; no AI prose generated</span>
      )}
    </div>
  );
}

function ProjectedView({ doc }: { doc: AlfredDocument }) {
  return (
    <>
      <div className="text-[11px] uppercase tracking-widest text-muted mb-3 italic">
        Projected — what the document looks like after accept
      </div>
      {doc.paragraphs.map((p) => (
        <p key={p.id}>
          {p.role && <span className="role-tag">{p.role}</span>}
          {p.text}
        </p>
      ))}
    </>
  );
}

function GlueLine({ text }: { text: string }) {
  return (
    <p className="my-2">
      <span className="role-tag text-[#2d5a2d]">Glue ↓</span>
      <span className="diff-glue">{text}</span>
    </p>
  );
}

// --- Build annotation map from operators ---

type Annotations = {
  get(id: string): Annotation | undefined;
  glueAfter: Map<string, string>;
  glueAtStart: Map<string, string>;
  glueAtEnd: string | null;
  idLabel: Map<string, string>;
};

function buildAnnotations(doc: AlfredDocument, ops: Operator[]): Annotations {
  const ann = new Map<string, Annotation>();
  const glueAfter = new Map<string, string>();
  const glueAtStart = new Map<string, string>();
  let glueAtEnd: string | null = null;
  const idLabel = new Map<string, string>();
  doc.paragraphs.forEach((p, i) => {
    idLabel.set(p.id, `§${i + 1}`);
  });

  for (const op of ops) {
    switch (op.kind) {
      case "split":
        ann.set(op.paragraph_id, { kind: "split-marker", sentenceIndex: op.after_sentence_index });
        break;
      case "merge":
        ann.set(op.first_paragraph_id, {
          kind: "merge-target",
          absorbsId: op.second_paragraph_id,
          glue: op.glue_text || undefined,
        });
        ann.set(op.second_paragraph_id, {
          kind: "merge-source",
          intoFirstId: op.first_paragraph_id,
          glue: op.glue_text || undefined,
        });
        break;
      case "move": {
        ann.set(op.paragraph_id, {
          kind: "move-source",
          targetDescription: describeMoveTarget(op.target_position, idLabel),
        });
        break;
      }
      case "hoist": {
        ann.set(op.paragraph_id, {
          kind: "move-source",
          targetDescription: describeMoveTarget(op.target_position, idLabel),
          role: op.target_role,
        });
        break;
      }
      case "demote":
        ann.set(op.paragraph_id, {
          kind: "demote-source",
          parentDescription: idLabel.get(op.parent_paragraph_id) ?? op.parent_paragraph_id.slice(0, 6),
        });
        break;
      case "migrate": {
        const original = doc.paragraphs.find((p) => p.id === op.paragraph_id)?.text ?? "";
        ann.set(op.paragraph_id, {
          kind: "migrate",
          oldText: original,
          newText: op.rewrite_text,
          changeBudget: op.change_budget_tokens,
        });
        break;
      }
      case "delete":
        ann.set(op.paragraph_id, { kind: "delete" });
        break;
      case "glue": {
        if (op.position.kind === "after") {
          glueAfter.set(op.position.paragraph_id, op.text);
        } else if (op.position.where === "start") {
          glueAtStart.set(doc.paragraphs[0]?.id ?? "", op.text);
        } else {
          glueAtEnd = op.text;
        }
        break;
      }
    }
  }

  return {
    get: (id) => ann.get(id),
    glueAfter,
    glueAtStart,
    glueAtEnd,
    idLabel,
  };
}

function describeMoveTarget(position: Operator extends { kind: "move" } ? Operator["target_position"] : any, idLabel: Map<string, string>): string {
  if (position.kind === "at") return position.where === "start" ? "to the top" : "to the end";
  return `after ${idLabel.get(position.paragraph_id) ?? position.paragraph_id.slice(0, 6)}`;
}
