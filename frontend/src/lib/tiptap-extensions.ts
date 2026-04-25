import { Paragraph } from "@tiptap/extension-paragraph";

// Extend the default paragraph node with Alfred metadata attrs.
export const AlfredParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      alfredId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-alfred-id"),
        renderHTML: (attrs) =>
          attrs.alfredId ? { "data-alfred-id": String(attrs.alfredId) } : {},
      },
      alfredRole: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-alfred-role"),
        renderHTML: (attrs) =>
          attrs.alfredRole ? { "data-alfred-role": String(attrs.alfredRole) } : {},
      },
      alfredParentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-alfred-parent"),
        renderHTML: (attrs) =>
          attrs.alfredParentId
            ? { "data-alfred-parent": String(attrs.alfredParentId) }
            : {},
      },
    };
  },
});
