// Workers AI-backed image generation. Returns bytes the caller persists
// (Isolate) or replays inline (Sandbox). The registry in `./index.ts`
// handles that branch because that's where workspace presence is
// observable.

import { z } from "zod";
import type { WorkersAiBinding } from "./shared";

// FLUX.2 [dev] is the highest-quality image model on Workers AI and is
// the default. It's slower than the distilled Klein variants but
// supports the full `steps` knob. Users can override via env var —
// the call path auto-detects flux-2 vs. flux-1 schnell and switches
// the input shape.
const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-dev";

export const cfImageGenerateCoreSchema = z.object({
  prompt: z.string().min(1).describe("Description of the image to generate."),
  steps: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe(
      "Number of inference steps for FLUX.2 [dev]. Higher = better, slower. Default 25. Ignored by distilled (klein) models.",
    ),
  width: z
    .number()
    .int()
    .min(256)
    .max(1920)
    .optional()
    .describe("Image width in pixels. Range 256-1920. Default 1024 (FLUX.2)."),
  height: z
    .number()
    .int()
    .min(256)
    .max(1920)
    .optional()
    .describe("Image height in pixels. Range 256-1920. Default 768 (FLUX.2)."),
});
export type CfImageGenerateCoreInput = z.infer<
  typeof cfImageGenerateCoreSchema
>;

// Pick the configured image model (env override → default) and resolve
// the AI binding. Returned to callers so the description string can
// interpolate the model name.
export function resolveCfImageModel(
  env: Env,
): { ai: WorkersAiBinding; model: string } | null {
  if (!env.AI) return null;
  // env.AI is typed as the full `Ai` binding; we only need `run`, which
  // the local `WorkersAiBinding` interface narrows to. Cast keeps the
  // call-site type tight without depending on the SDK's wider shape.
  const ai = env.AI as unknown as WorkersAiBinding;
  const model = DEFAULT_IMAGE_MODEL;
  return { ai, model };
}

// FLUX.2 family models on Workers AI consume multipart form data, even
// for a prompt-only call. Older FLUX 1 Schnell takes JSON. Detect by
// model name so callers don't need to thread a flag through.
function isFlux2Model(model: string): boolean {
  return model.includes("flux-2");
}

// Generate-only helper. Returns either a Uint8Array of PNG/JPEG bytes
// or a stringified error. Shared between the Isolate factory (writes
// to workspace) and the MicroVM-side dispatcher (returns the bytes
// inline as a content block).
export async function generateCfImageBytes(
  input: CfImageGenerateCoreInput,
  env: Env,
): Promise<{ bytes: Uint8Array; model: string } | string> {
  const resolved = resolveCfImageModel(env);
  if (!resolved) return "error: AI binding not configured";
  const { ai, model } = resolved;
  let result: unknown;
  if (isFlux2Model(model)) {
    // FLUX.2 requires multipart form data. FormData doesn't expose its
    // serialized body or boundary directly, so we wrap it in a Response
    // to materialize the stream and pick up the matching Content-Type
    // (boundary included) — without that header the upstream parser
    // rejects the request.
    const form = new FormData();
    form.append("prompt", input.prompt);
    if (input.steps !== undefined) form.append("steps", String(input.steps));
    if (input.width !== undefined) form.append("width", String(input.width));
    if (input.height !== undefined) form.append("height", String(input.height));
    const formResponse = new Response(form);
    const formStream = formResponse.body;
    const formContentType = formResponse.headers.get("content-type");
    if (!formStream || !formContentType) {
      return "error: failed to serialize multipart form";
    }
    result = await ai.run(model, {
      multipart: { body: formStream, contentType: formContentType },
    });
  } else {
    result = await ai.run(model, {
      prompt: input.prompt,
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
    });
  }
  // FLUX.2 models return a binary stream of bytes. FLUX 1 Schnell
  // returns `{ image: <base64 png> }`. We tolerate both shapes plus a
  // plain Uint8Array so future models that ship raw bytes "just work".
  let bytes: Uint8Array;
  if (typeof result === "object" && result !== null && "image" in result) {
    const b64 = (result as { image: string }).image;
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else if (result instanceof ReadableStream) {
    const reader = result.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
  } else if (result instanceof Uint8Array) {
    bytes = result;
  } else {
    return `error: unexpected AI response shape: ${typeof result}`;
  }
  return { bytes, model };
}
