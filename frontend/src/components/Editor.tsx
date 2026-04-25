import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useImperativeHandle, forwardRef } from "react";
import { AlfredParagraph } from "@/lib/tiptap-extensions";
import { documentToTiptap, paragraphsFromMarkdown, tiptapToDocument } from "@/lib/document";
import type { AlfredDocument } from "@/lib/types";

export type EditorHandle = {
  getDocument: () => AlfredDocument;
  setDocument: (doc: AlfredDocument) => void;
  loadMarkdown: (md: string) => void;
  focus: () => void;
};

type Props = {
  onReady?: (handle: EditorHandle) => void;
  diffMode?: boolean;
};

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ onReady, diffMode = false }, ref) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        paragraph: false, // we replace it
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      AlfredParagraph,
      Placeholder.configure({
        placeholder:
          "Start writing. Or paste a draft. Press Cmd+K to invoke Alfred — say things like “graf 3 drags” or “buried thesis — find it”.",
      }),
    ],
    editorProps: {
      attributes: {
        class: "alfred-prose px-12 py-16 max-w-prose mx-auto",
        spellcheck: "false",
      },
      // disable input while diff is showing
      editable: () => !diffMode,
    },
    content: "",
  });

  const getDocument = () => (editor ? tiptapToDocument(editor) : { paragraphs: [] });

  const setDocument = (doc: AlfredDocument) => {
    if (!editor) return;
    if (doc.paragraphs.length === 0) {
      editor.commands.setContent("");
      return;
    }
    editor.commands.setContent(documentToTiptap(doc) as never);
  };

  const loadMarkdown = (md: string) => {
    setDocument(paragraphsFromMarkdown(md));
  };

  const focus = () => editor?.commands.focus();

  useImperativeHandle(ref, () => ({ getDocument, setDocument, loadMarkdown, focus }), [editor]);

  useEffect(() => {
    if (editor && onReady) {
      onReady({ getDocument, setDocument, loadMarkdown, focus });
    }
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!diffMode);
  }, [diffMode, editor]);

  return <EditorContent editor={editor} />;
});
