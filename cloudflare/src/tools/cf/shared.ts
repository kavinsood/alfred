// Shared helpers and types used by every `cf_*` tool group. Kept in
// one module so each group file (browser / ai / vpc / email) can stay
// focused on its own surface area.
//
// What lives here:
//   - response-size cap + truncate wrapper
//   - workspace path normaliser
//   - Browser Rendering dispatch helpers shared between the four
//     browser-facing tools (probe, REST vs binding selection,
//     puppeteer driver, JSON envelope unwrap)
//   - image MIME magic-byte detection
//   - `CfToolDeps` — the dependency bag every tool factory receives

import type { Workspace } from "@cloudflare/shell";
import { truncate as truncateText } from "../../helpers";

// Cap heavy text outputs so we don't blow past Anthropic's tool result
// budget. 200 KB ≈ 50K tokens which still leaves headroom for the model's
// reply. HTML and markdown returns get truncated with a clear suffix; the
// model can ask for more by re-fetching with a tighter selector.
export const MAX_TEXT_BYTES = 200_000;

// Cap-aware truncate wrapper. The shared helper takes an explicit max;
// keeping a thin alias avoids touching the dozen call sites that pass
// nothing and expect MAX_TEXT_BYTES.
export function truncate(s: string, max = MAX_TEXT_BYTES): string {
  return truncateText(s, max);
}

// Workspace paths normalise to absolute, so a leading-slash check is
// enough to distinguish them from URLs / external blob refs.
export function ensureAbsolute(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

// Detect a binary image's mime type from its magic bytes. Workers AI's
// FLUX models return JPEG even though older docs claimed PNG; we'd
// rather label the bytes accurately than hard-code an assumption that
// breaks silently when a model changes its output format. Falls back
// to image/png — the historical default — when nothing matches.
export function detectImageMime(bytes: Uint8Array): string {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png";
}

// Workers AI binding shape — narrowed to the `run` method the image
// generator actually calls. The binding's real type is much wider; the
// narrowed view keeps tool factory call sites tight without importing
// the SDK's full surface area.
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Browser Rendering — two paths.
// ---------------------------------------------------------------------------
//
// Cloudflare exposes Browser Rendering two ways and both are first-class:
//
//   1. REST API ("Quick Actions") at
//      /accounts/:id/browser-rendering/:endpoint, authenticated with a
//      Cloudflare API token. Hosted, includes a server-side
//      HTML→markdown converter, and supports operations the binding
//      doesn't expose directly (PDF, scrape, etc.).
//
//   2. Workers binding via @cloudflare/puppeteer. The agent has a
//      `BROWSER` binding; we drive a real Chrome through it. No
//      account-id / token secrets needed — the binding is the
//      credential.
//
// Most accounts have one or the other configured, not both. We accept
// either: prefer the REST path when its credentials are present
// (faster, no puppeteer overhead, supports `/markdown` natively),
// otherwise fall back to the binding via puppeteer. For markdown on
// the binding path we round-trip through `env.AI.toMarkdown()` if the
// Workers AI binding is present; otherwise the tool returns the raw
// HTML with a note.
//
// All four `cf_*` browser tools call into `callBrowserRendering` below
// — the dispatch on REST vs binding lives there.

export type BrowserRenderingDeps =
  | {
      mode: "rest";
      accountId: string;
      apiToken: string;
    }
  | {
      mode: "binding";
      browser: Fetcher;
      // Optional AI binding for HTML→markdown conversion. When absent
      // the markdown helpers fall back to returning HTML.
      ai?: WorkersAiBinding;
    };

export function browserRenderingDeps(env: Env): BrowserRenderingDeps | null {
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, BROWSER, AI } = env;
  if (CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN) {
    return {
      mode: "rest",
      accountId: CLOUDFLARE_ACCOUNT_ID,
      apiToken: CLOUDFLARE_API_TOKEN,
    };
  }
  if (BROWSER) {
    return {
      mode: "binding",
      browser: BROWSER,
      ...(AI ? { ai: AI as unknown as WorkersAiBinding } : {}),
    };
  }
  return null;
}

export interface BrowserRequestInit {
  url?: string;
  html?: string;
  // Forwarded as `viewport`, `gotoOptions`, etc. The Browser Rendering REST
  // API accepts a generous superset; we don't validate aggressively because
  // the API itself does and the model will see the error if it sends
  // something invalid.
  [key: string]: unknown;
}

// Lazy-loaded puppeteer reference. Imported only when the binding path
// is actually used so REST-only deployments don't pull the Chromium
// glue into their startup graph. The dynamic import resolves to the
// `@cloudflare/puppeteer` default export.
let puppeteerCache: typeof import("@cloudflare/puppeteer").default | null =
  null;
async function loadPuppeteer(): Promise<
  typeof import("@cloudflare/puppeteer").default
> {
  if (!puppeteerCache) {
    const mod = await import("@cloudflare/puppeteer");
    puppeteerCache = mod.default;
  }
  return puppeteerCache;
}

// Wrap a string/bytes payload in a fake REST-shaped Response so the
// existing run functions (which call `unwrapJson` / `await
// res.arrayBuffer()`) keep working unchanged when we route through the
// binding path.
function fakeRestResponse(
  payload: string | Uint8Array,
  kind: "json" | "binary",
): Response {
  if (kind === "binary") {
    return new Response(payload as Uint8Array, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  return new Response(
    JSON.stringify({ success: true, result: payload as string }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

// Drive the BROWSER binding via puppeteer for one of the REST-equivalent
// operations. Each call opens a fresh page and closes the browser when
// done so we don't leak Browser Rendering sessions.
//
// For `markdown` we only get HTML out of puppeteer; the binding path
// uses `env.AI.toMarkdown()` to do the conversion. That requires the
// AI binding; without it we return the raw HTML with an explanatory
// prefix so the model can still make progress.
async function callBrowserViaBinding(
  deps: Extract<BrowserRenderingDeps, { mode: "binding" }>,
  endpoint: "screenshot" | "markdown" | "content",
  body: BrowserRequestInit,
): Promise<Response> {
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch(deps.browser);
  try {
    const page = await browser.newPage();
    if (body.viewport && typeof body.viewport === "object") {
      const vp = body.viewport as { width?: number; height?: number };
      if (vp.width && vp.height) {
        await page.setViewport({ width: vp.width, height: vp.height });
      }
    }
    if (typeof body.url === "string") {
      const goto =
        (body.gotoOptions as {
          waitUntil?: "load" | "networkidle0" | "networkidle2";
        }) ?? {};
      await page.goto(body.url, {
        waitUntil: goto.waitUntil ?? "networkidle2",
        timeout: 30_000,
      });
    } else if (typeof body.html === "string") {
      await page.setContent(body.html, {
        waitUntil: "networkidle2",
        timeout: 30_000,
      });
    }

    if (endpoint === "screenshot") {
      const opts = (body.screenshotOptions as { fullPage?: boolean }) ?? {};
      const buf = (await page.screenshot({
        fullPage: !!opts.fullPage,
        type: "png",
      })) as Uint8Array | Buffer | string;
      // Puppeteer can return Buffer (Node), Uint8Array (Workers), or
      // base64 string depending on how it's built. Normalise to bytes.
      let bytes: Uint8Array;
      if (typeof buf === "string") {
        const bin = atob(buf);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else if (buf instanceof Uint8Array) {
        bytes = buf;
      } else {
        // Buffer (Node-shaped) — copy into a fresh Uint8Array view so
        // it satisfies the Workers fetch body type.
        bytes = new Uint8Array(buf as unknown as ArrayBufferLike);
      }
      return fakeRestResponse(bytes, "binary");
    }

    if (endpoint === "content") {
      const html = await page.content();
      return fakeRestResponse(html, "json");
    }

    // markdown — convert HTML via env.AI.toMarkdown() when available.
    const html = await page.content();
    if (!deps.ai) {
      return fakeRestResponse(
        `(workers-ai binding missing — returning raw HTML; configure 'AI' in wrangler.jsonc to get clean markdown)\n\n${html}`,
        "json",
      );
    }
    const aiAny = deps.ai as unknown as {
      toMarkdown: (
        files: Array<{ name: string; blob: Blob }>,
      ) => Promise<Array<{ format: string; data?: string; error?: string }>>;
    };
    const result = await aiAny.toMarkdown([
      { name: "page.html", blob: new Blob([html], { type: "text/html" }) },
    ]);
    const first = Array.isArray(result)
      ? result[0]
      : (result as unknown as { format: string; data?: string });
    if (
      !first ||
      first.format !== "markdown" ||
      typeof first.data !== "string"
    ) {
      return fakeRestResponse(
        `(toMarkdown failed — returning raw HTML)\n\n${html}`,
        "json",
      );
    }
    return fakeRestResponse(first.data, "json");
  } finally {
    try {
      await browser.close();
    } catch {
      // close failures are noisy and non-fatal — the session will time
      // out on its own per Cloudflare's idle limit.
    }
  }
}

export async function callBrowserRendering(
  deps: BrowserRenderingDeps,
  endpoint: "screenshot" | "markdown" | "content" | "scrape" | "snapshot",
  body: BrowserRequestInit,
): Promise<Response> {
  if (deps.mode === "rest") {
    const url = `https://api.cloudflare.com/client/v4/accounts/${deps.accountId}/browser-rendering/${endpoint}`;
    return fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
  // binding mode — only screenshot / content / markdown have puppeteer
  // equivalents in this client. scrape / snapshot remain REST-only.
  if (endpoint === "scrape" || endpoint === "snapshot") {
    return new Response(
      JSON.stringify({
        success: false,
        errors: [
          {
            message: `endpoint ${endpoint} requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID; the BROWSER binding alone does not expose it`,
          },
        ],
      }),
      { status: 501, headers: { "content-type": "application/json" } },
    );
  }
  return callBrowserViaBinding(deps, endpoint, body);
}

// Read the standard Cloudflare API JSON envelope and return the inner
// `result` field, throwing on non-2xx or { success: false }. Browser
// Rendering endpoints follow the same envelope as the rest of the API.
export async function unwrapJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `browser rendering returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok || !parsed || typeof parsed !== "object") {
    const errMsg = (
      parsed as { errors?: Array<{ message?: string }> } | null
    )?.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `browser rendering ${res.status}: ${errMsg || text.slice(0, 200) || "unknown error"}`,
    );
  }
  const env = parsed as {
    success?: boolean;
    result?: T;
    errors?: Array<{ message?: string }>;
  };
  if (env.success === false) {
    const errMsg = env.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`browser rendering error: ${errMsg || "request failed"}`);
  }
  return env.result as T;
}

export interface CfToolDeps {
  // Optional. Isolate sessions pass the DO-local Workspace so image tools
  // can persist bytes the model can read back with `cf_read`. Sandbox
  // sessions (MicroVM) don't have a Worker-side workspace — the container
  // has its own /workspace filesystem that the DO can't reach — so we
  // pass `undefined` there. Image-producing factories branch on this:
  // workspace present → save + return path text; absent → return inline
  // image content blocks the model receives directly.
  workspace?: Workspace;
  env: Env;
  sessionId: string;
}
