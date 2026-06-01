// Browser Rendering-backed tools: cf_web_fetch, fetch_to_markdown,
// browse, screenshot. Each is a thin wrapper around the dispatch
// helpers in `./shared.ts`.
//
// Screenshot returns bytes the caller persists (Isolate) or replays
// inline (Sandbox) — the registry in `./index.ts` handles the branch
// because that's where workspace presence is observable.

import { z } from "zod";
import { bytesToBase64, formatErr } from "../../helpers";
import {
  browserRenderingDeps,
  callBrowserRendering,
  MAX_TEXT_BYTES,
  truncate,
  unwrapJson,
  type BrowserRequestInit,
} from "./shared";

// Pull `<title>` out of a rendered HTML response. Used to populate the
// `title` field of cf_web_fetch's structured response so the model can
// cite "according to <title>…" without reading the full document. The
// regex is deliberately lax: title content can contain anything but
// closing-tag triggers, which it never does in practice.
function extractTitleFromHtml(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const decoded = decodeBasicHtmlEntities(m[1]).trim();
  if (!decoded) return undefined;
  // Cap at 300 chars so a pathologically long <title> doesn't bloat the
  // tool result. Real-world titles are far shorter.
  return decoded.slice(0, 300);
}

// First H1 line of a markdown document, used as a title fallback when
// we only have markdown (e.g. format=markdown, where we'd otherwise
// need a second BR call to fetch HTML for the title). Skips leading
// whitespace lines; bails out on the first non-empty non-H1 line so
// we don't accidentally pick a sub-heading further down.
function extractTitleFromMarkdown(md: string): string | undefined {
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) return line.slice(2).trim().slice(0, 300);
    return undefined;
  }
  return undefined;
}

// Decode the small handful of entities that show up in <title> tags. A
// full entity decoder is overkill — these five cover virtually every
// real title we'll see.
function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// HEAD probe a URL to learn its content-type (for PDF detection) and
// the resolved URL (after redirects). Returns null when the server
// rejects HEAD or any network error fires — the caller falls through
// to the GET path so we don't break on hosts that block HEAD. Limited
// to a 5s timeout because some hosts make HEAD slow to discourage
// scrapers; we'd rather punt than hang.
interface UrlProbe {
  finalUrl: string;
  contentType: string;
  isPdf: boolean;
}

async function probeUrl(url: string): Promise<UrlProbe | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    const contentType = (res.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    return {
      finalUrl: res.url || url,
      contentType: contentType || "text/html",
      isPdf:
        contentType === "application/pdf" || url.toLowerCase().endsWith(".pdf"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shared schema for screenshot inputs that don't depend on a workspace.
// The Isolate factory layers a workspace `path` on top; the MicroVM
// variant returns the bytes inline as an image content block via the
// custom-tool dispatcher.

export const cfScreenshotCoreSchema = z.object({
  url: z.string().url().describe("URL to screenshot."),
  full_page: z
    .boolean()
    .optional()
    .describe(
      "Capture the full scroll height instead of the viewport. Default false.",
    ),
  viewport_width: z.number().int().positive().optional(),
  viewport_height: z.number().int().positive().optional(),
});
export type CfScreenshotCoreInput = z.infer<typeof cfScreenshotCoreSchema>;

// Capture-only helper. Returns either a Uint8Array or a stringified error
// message. Shared between the Isolate factory (which writes to the
// workspace) and the MicroVM-side dispatcher (which returns the bytes
// inline as a content block). Browser rendering deps are gated by the
// caller — this fn throws if the env is missing the binding.
export async function captureCfScreenshotBytes(
  input: CfScreenshotCoreInput,
  env: Env,
): Promise<Uint8Array | string> {
  const br = browserRenderingDeps(env);
  if (!br) return "error: browser rendering binding not configured";
  const body: BrowserRequestInit = {
    url: input.url,
    screenshotOptions: { fullPage: !!input.full_page },
  };
  if (input.viewport_width || input.viewport_height) {
    body.viewport = {
      width: input.viewport_width ?? 1280,
      height: input.viewport_height ?? 800,
    };
  }
  const res = await callBrowserRendering(br, "screenshot", body);
  if (!res.ok) {
    const text = await res.text();
    return `error: browser rendering ${res.status}: ${text.slice(0, 400)}`;
  }
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// fetch_to_markdown — single URL → clean markdown.

export const cfFetchMarkdownSchema = z.object({ url: z.string().url() });
export type CfFetchMarkdownInput = z.infer<typeof cfFetchMarkdownSchema>;
export const cfFetchMarkdownDescription =
  "Fetch a URL via Cloudflare Browser Rendering and convert the page to markdown. Use this for reading articles, documentation, blog posts, or any human-readable web page where you want the prose without the markup. Returns markdown directly (truncated at 200 KB).";
export async function runCfFetchMarkdown(
  input: CfFetchMarkdownInput,
  env: Env,
): Promise<string> {
  const br = browserRenderingDeps(env);
  if (!br) return "error: browser rendering binding not configured";
  try {
    const res = await callBrowserRendering(br, "markdown", { url: input.url });
    const out = await unwrapJson<string>(res);
    return truncate(out);
  } catch (error) {
    return formatErr(error);
  }
}

// ---------------------------------------------------------------------------
// browse — single URL → rendered HTML.

export const cfBrowseSchema = z.object({ url: z.string().url() });
export type CfBrowseInput = z.infer<typeof cfBrowseSchema>;
export const cfBrowseDescription =
  "Browse a URL via Cloudflare Browser Rendering and return the rendered HTML (after JavaScript execution). Useful for inspecting structure, extracting attributes, or scraping. Prefer fetch_to_markdown for prose extraction.";
export async function runCfBrowse(
  input: CfBrowseInput,
  env: Env,
): Promise<string> {
  const br = browserRenderingDeps(env);
  if (!br) return "error: browser rendering binding not configured";
  try {
    const res = await callBrowserRendering(br, "content", { url: input.url });
    const out = await unwrapJson<string>(res);
    return truncate(out);
  } catch (error) {
    return formatErr(error);
  }
}

// ---------------------------------------------------------------------------
// cf_web_fetch — Cloudflare-flavoured analogue of Anthropic's built-in
// `web_fetch`. Same conceptual shape (URL in, content out) but routed
// through Browser Rendering so:
//   - The fetch is billed to and observable on the user's Cloudflare
//     account (Workers Logs, Logpush, BR dashboard) instead of running
//     on Anthropic's infrastructure where the operator has no visibility.
//   - JS-heavy pages render correctly because BR drives a real Chrome.
//
// Note: the actual outbound to the target URL happens inside Cloudflare's
// Browser Rendering service, not from this Worker. The per-session egress
// policy (`src/egress/`) only wraps fetches issued from inside the
// sandbox (the container on MicroVM, the dynamic Worker spawned by
// `execute` / `run_file` on Isolate), so BR-mediated requests do NOT
// traverse it.
//
// Output shape mirrors Anthropic's `web_fetch_tool_result.content`:
//   {
//     url:           final URL after redirects,
//     title:         <title> (HTML) or first H1 (markdown), if available,
//     retrieved_at:  ISO timestamp,
//     content: {
//       type:        "document",
//       media_type:  "text/markdown" | "text/html" | "application/pdf",
//       encoding:    "base64" (PDF only, omitted otherwise),
//       data:        truncated string or base64-encoded bytes,
//       size_bytes:  byte count (PDF only),
//     },
//   }
// Returned as JSON.stringify so the dispatcher transports it as a
// single string. The model treats the JSON as an object on parse.
//
// Three modes:
//   - PDF (auto-detected via HEAD content-type or .pdf extension):
//     bypass BR, fetch directly, return base64 + media_type
//     application/pdf. Matches the built-in's PDF behaviour.
//   - HTML (format="html"): one BR /content call, regex out the title.
//   - Markdown (format="markdown", default): one BR /markdown call,
//     pull the title from the first H1.
//
// We deliberately keep this to one BR call per non-PDF fetch — calling
// /content + /markdown in parallel for every fetch would double cost
// and latency for a marginal title-quality improvement.
export const cfWebFetchSchema = z.object({
  url: z.string().url(),
  format: z
    .enum(["markdown", "html"])
    .default("markdown")
    .describe(
      "Body format for non-PDF pages. `markdown` (default) for clean prose, `html` for raw markup. Ignored when the URL serves a PDF.",
    ),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(MAX_TEXT_BYTES)
    .optional()
    .describe(
      `Cap the body at this many characters (default ${MAX_TEXT_BYTES}). Use a smaller value when context is tight.`,
    ),
});
export type CfWebFetchInput = z.infer<typeof cfWebFetchSchema>;
export const cfWebFetchDescription =
  "Fetch a URL using Cloudflare Browser Rendering. Returns a JSON document block matching Anthropic's web_fetch shape: { url (post-redirect), title, retrieved_at, content: { media_type, data } }. PDFs are auto-detected and returned as base64 with media_type application/pdf. Prefer this over the built-in web_fetch when both are available — requests run on the user's Cloudflare account (observable in Workers Logs / Logpush / the BR dashboard) and JS-heavy pages render correctly because BR drives a real Chrome.";

export async function runCfWebFetch(
  input: CfWebFetchInput,
  env: Env,
): Promise<string> {
  const br = browserRenderingDeps(env);
  if (!br) return "error: browser rendering binding not configured";
  const cap = input.max_chars ?? MAX_TEXT_BYTES;
  const retrievedAt = new Date().toISOString();
  const url = input.url;
  const format = input.format;
  try {
    // 1) HEAD probe so we know the final URL (post-redirect) and
    //    whether the server is serving a PDF. HEAD failures are
    //    non-fatal — we proceed assuming HTML and trust BR to error
    //    out cleanly if the URL is unfetchable.
    const probe = await probeUrl(url);
    const finalUrl = probe?.finalUrl ?? url;

    // 2) PDF path: bypass Browser Rendering. BR's /markdown and
    //    /content endpoints don't extract PDF text; we'd just get
    //    the PDF viewer's HTML. We fetch directly from the DO — same
    //    posture as the BR-mediated path: visible on the user's
    //    Cloudflare account but not subject to the per-session egress
    //    policy (that wraps in-sandbox fetches, not DO-level ones).
    if (probe?.isPdf) {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        return JSON.stringify({
          error: "url_not_accessible",
          status: res.status,
          url: res.url || finalUrl,
        });
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return JSON.stringify({
        url: res.url || finalUrl,
        retrieved_at: retrievedAt,
        content: {
          type: "document",
          media_type: "application/pdf",
          encoding: "base64",
          data: bytesToBase64(buf),
          size_bytes: buf.byteLength,
        },
      });
    }

    // 3) Non-PDF: hand off to Browser Rendering. /markdown gives us
    //    clean prose, /content gives us rendered HTML. The format
    //    param picks one — no second call.
    const endpoint = format === "html" ? "content" : "markdown";
    const res = await callBrowserRendering(br, endpoint, { url });
    const body = await unwrapJson<string>(res);
    const title =
      format === "html"
        ? extractTitleFromHtml(body)
        : extractTitleFromMarkdown(body);

    return JSON.stringify({
      url: finalUrl,
      ...(title ? { title } : {}),
      retrieved_at: retrievedAt,
      content: {
        type: "document",
        media_type: format === "html" ? "text/html" : "text/markdown",
        data: truncate(body, cap),
      },
    });
  } catch (error) {
    // Mirror the built-in's error shape (a JSON object with an
    // error_code-ish field) so prompts written against either tool
    // can branch on the same key.
    return JSON.stringify({
      error: "url_not_accessible",
      message: error instanceof Error ? error.message : String(error),
      url,
      retrieved_at: retrievedAt,
    });
  }
}
