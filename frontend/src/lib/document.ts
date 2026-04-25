// Convert between Tiptap's ProseMirror JSON document and our AlfredDocument format.

import type { Editor } from "@tiptap/react";
import type { AlfredDocument, Paragraph, ParagraphRole } from "./types";
import { randomId } from "./operators";

type ProseNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseNode[];
  text?: string;
  marks?: Array<{ type: string }>;
};

export function tiptapToDocument(editor: Editor): AlfredDocument {
  const json = editor.getJSON() as ProseNode;
  return jsonToDocument(json);
}

export function jsonToDocument(json: ProseNode): AlfredDocument {
  const paragraphs: Paragraph[] = [];
  const top = (json.content ?? []) as ProseNode[];
  for (const node of top) {
    if (node.type !== "paragraph") continue;
    const text = readPlainText(node);
    if (text.trim().length === 0) continue; // skip empty paragraphs
    const attrs = (node.attrs ?? {}) as Record<string, unknown>;
    const id = typeof attrs.alfredId === "string" && attrs.alfredId.length > 0
      ? attrs.alfredId
      : randomId();
    const role = typeof attrs.alfredRole === "string"
      ? (attrs.alfredRole as ParagraphRole)
      : undefined;
    const parent_id = typeof attrs.alfredParentId === "string"
      ? attrs.alfredParentId
      : undefined;
    paragraphs.push({ id, text, role, parent_id });
  }
  return { paragraphs };
}

export function documentToTiptap(doc: AlfredDocument): ProseNode {
  return {
    type: "doc",
    content: doc.paragraphs.map((p) => ({
      type: "paragraph",
      attrs: {
        alfredId: p.id,
        alfredRole: p.role ?? null,
        alfredParentId: p.parent_id ?? null,
      },
      content: [{ type: "text", text: p.text }],
    })),
  };
}

export function paragraphsFromMarkdown(md: string): AlfredDocument {
  const paragraphs: Paragraph[] = md
    .split(/\r?\n\r?\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ id: randomId(), text: p.replace(/\s+/g, " ") }));
  return { paragraphs };
}

function readPlainText(node: ProseNode): string {
  if (node.type === "text") return node.text ?? "";
  if (!node.content) return "";
  return node.content.map(readPlainText).join("");
}
