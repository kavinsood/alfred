// Email tools — send + inbox.
//
// Outbound: uses the Email Workers `send_email` binding. Cloudflare requires
// the destination to be a verified address on the same zone; users register
// destinations via the dashboard. We fail loudly with a setup hint when the
// binding isn't configured.
//
// Inbound: each agent owns a public address `<alias>@<EMAIL_DOMAIN>`. The
// alias is auto-provisioned by the webhook resolver (and by this tool's
// own first call) and stored in the `agent_emails` table. Replies route
// back to the originating session via a Message-ID we stamp on every
// outbound; counterparties that compose-fresh fall through to a
// (agent, counterparty) thread mapping in `email_threads`.
//
// The Email Worker handler in `src/email-handler.ts` writes incoming
// messages to the `inbox` table in D1, keyed by session id. The
// email_inbox / email_read tools below read from that table.
//
// We deliberately keep email-as-a-tool minimal: send, list, read. Anything
// fancier (threads, labels) belongs in the agent's own logic.

import { z } from "zod";
import { formatErr } from "../../helpers";
import {
  ensureAgentPrimaryEmail,
  getPrimaryAliasForAgent,
  getSessionBackend,
  recordSentMessage,
} from "../../storage";
import { truncate } from "./shared";

interface EmailSendBinding {
  // The send_email binding accepts a MIME message as a Headers + body
  // pair; the SDK shape matches `EmailMessage` from cloudflare:email.
  send(message: unknown): Promise<void>;
}

async function buildMimeMessage(opts: {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  messageId?: string;
}): Promise<{ raw: string; from: string; to: string }> {
  const boundary = `cf-mail-${crypto.randomUUID()}`;
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  lines.push(`Subject: ${opts.subject}`);
  if (opts.messageId) {
    // RFC 5322 §3.6.4. Angle brackets are required for the wire format;
    // mail clients use the value verbatim in their In-Reply-To headers
    // when a recipient hits reply, which is the whole point of stamping
    // it: that value lets us route the reply back to the same session.
    lines.push(`Message-ID: <${opts.messageId}>`);
  }
  lines.push("MIME-Version: 1.0");
  if (opts.htmlBody) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(opts.textBody);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(opts.htmlBody);
    lines.push(`--${boundary}--`);
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(opts.textBody);
  }
  return {
    raw: lines.join("\r\n"),
    from: opts.from,
    to: opts.to,
  };
}

// Resolve the From: address + agent_id for an outbound send. We start
// from the agent_emails table (the agent's primary alias, auto-provisioned
// on first sighting), fall back to EMAIL_FROM, then null. The returned
// agentId is used by the caller to log + persist the sent_messages row.
//
// Both lookups are cheap (single D1 row each) and only run on email_send,
// not on the hot path of inbound dispatching.
async function resolveAgentInboxAddress(
  env: Env,
  sessionId: string,
): Promise<{ address: string | null; agentId: string | null }> {
  const domain = env.EMAIL_DOMAIN;
  if (!domain) return { address: null, agentId: null };
  if (!env.DB) return { address: null, agentId: null };
  const { agentId } = await getSessionBackend(env.DB, sessionId);
  if (!agentId) return { address: null, agentId: null };
  // Provision-on-demand: if email_send fires before the webhook
  // resolver ever cached an agent_id (unlikely but possible — a freshly
  // dispatched session may not have flushed the cache yet), ensure a
  // primary alias exists before computing the address.
  let alias: string | null = null;
  try {
    alias = await ensureAgentPrimaryEmail(env.DB, agentId);
  } catch (error) {
    console.warn(
      `[email_send] failed to provision alias for agent=${agentId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    alias = await getPrimaryAliasForAgent(env.DB, agentId);
  }
  if (!alias) return { address: null, agentId };
  return { address: `${alias}@${domain}`, agentId };
}

// Core schema for email_send (no session_id). Both backends use it
// as-is — sessionId is provided by the dispatcher's context (Isolate
// runner or Sandbox DO), so it never appears in the wire schema the
// model sees.
export const cfEmailSendCoreSchema = z.object({
  to: z.string().email().describe("Verified destination email address."),
  subject: z.string().min(1),
  body: z.string().min(1).describe("Plain-text body."),
  html: z
    .string()
    .optional()
    .describe("Optional HTML body — sent as a multipart alternative."),
  from: z
    .string()
    .email()
    .optional()
    .describe(
      "From address. Defaults to the agent's public inbox address (`<alias>@EMAIL_DOMAIN`) when EMAIL_DOMAIN is set, otherwise EMAIL_FROM. Must belong to a zone you control.",
    ),
});
export type CfEmailSendCoreInput = z.infer<typeof cfEmailSendCoreSchema>;

export async function runCfEmailSend(
  input: CfEmailSendCoreInput & { sessionId: string },
  env: Env,
): Promise<string> {
  // The SEND_EMAIL binding is typed `SendEmail` by wrangler; our local
  // `EmailSendBinding` interface narrows to just the `send` method we
  // actually call, so a thin cast keeps the call-site type tight.
  const send = env.SEND_EMAIL as unknown as EmailSendBinding | undefined;
  if (!send) return "error: SEND_EMAIL binding not configured";
  // Resolve the agent's primary alias for both the default From: address
  // and the sent_messages row that lets us route replies back here. If
  // the agent_id isn't yet cached on the sessions row (very early in a
  // session's life), `agentId` is null and we fall back to EMAIL_FROM
  // without writing a sent_messages row — that send just won't benefit
  // from Message-ID threading on its reply.
  const { address: agentInboxAddress, agentId } =
    await resolveAgentInboxAddress(env, input.sessionId);
  const defaultFrom = agentInboxAddress ?? env.EMAIL_FROM ?? null;
  try {
    const fromAddr = input.from ?? defaultFrom;
    if (!fromAddr) {
      return "error: no `from` address — pass one explicitly or set EMAIL_FROM / EMAIL_DOMAIN";
    }
    // Stamp a Message-ID that encodes the session. Reply clients echo
    // this value into their In-Reply-To header verbatim; the email
    // handler looks the id up in sent_messages and routes the reply
    // back here. Domain part has to be syntactically valid — we use
    // EMAIL_DOMAIN when available (recipients sometimes display it),
    // falling back to "cf-agents.local" so even sends without a
    // configured domain still get a well-formed id.
    const domain = env.EMAIL_DOMAIN || "cf-agents.local";
    const messageId = `${input.sessionId}.${crypto.randomUUID()}@${domain}`;
    const message = await buildMimeMessage({
      from: fromAddr,
      to: input.to,
      subject: input.subject,
      textBody: input.body,
      messageId,
      ...(input.html ? { htmlBody: input.html } : {}),
    });
    // Dynamically import the runtime helper so test harnesses can
    // load this module without the cloudflare:email module present.
    const { EmailMessage } = (await import("cloudflare:email")) as {
      EmailMessage: new (from: string, to: string, raw: string) => unknown;
    };
    await send.send(new EmailMessage(message.from, message.to, message.raw));
    // Best-effort: persist the (Message-ID → session) mapping so the
    // email handler can route an eventual reply back. Skipped when we
    // don't yet know the agent_id, or when the DB is absent.
    const db = env.DB;
    if (db && agentId) {
      try {
        await recordSentMessage(
          db,
          messageId,
          input.sessionId,
          agentId,
          input.to,
        );
      } catch (error) {
        console.warn(
          `[email_send] failed to record sent message=${messageId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return `sent to ${input.to} (subject: ${input.subject.slice(0, 80)})`;
  } catch (error) {
    return formatErr(error);
  }
}

interface InboxRow {
  message_id: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  received_at_ms: number;
  size_bytes: number;
}

interface InboxBodyRow extends InboxRow {
  body_text: string | null;
  body_html: string | null;
}

export const cfEmailInboxCoreSchema = z.object({
  limit: z.number().int().positive().max(50).optional(),
  since_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Only return messages received after this Unix epoch ms."),
});
export type CfEmailInboxCoreInput = z.infer<typeof cfEmailInboxCoreSchema>;

export async function runCfEmailInbox(
  input: CfEmailInboxCoreInput & { sessionId: string },
  env: Env,
): Promise<string> {
  const db = env.DB;
  if (!db) return "error: DB binding not configured";
  // Surface the agent's public address so the model can quote it back
  // to a counterparty (`my address is …`). Skipped silently when
  // EMAIL_DOMAIN isn't configured or the agent hasn't been resolved.
  const { address: inboxAddress } = await resolveAgentInboxAddress(
    env,
    input.sessionId,
  );
  try {
    const lim = input.limit ?? 25;
    const cutoff = input.since_ms ?? 0;
    const rows = await db
      .prepare(
        `SELECT message_id, from_addr, to_addr, subject, received_at_ms, size_bytes
         FROM inbox
         WHERE session_id = ? AND received_at_ms >= ?
         ORDER BY received_at_ms DESC
         LIMIT ?`,
      )
      .bind(input.sessionId, cutoff, lim)
      .all<InboxRow>();
    const items = (rows.results ?? []).map((r) => ({
      id: r.message_id,
      from: r.from_addr,
      to: r.to_addr,
      subject: r.subject,
      receivedAt: new Date(r.received_at_ms).toISOString(),
      sizeBytes: r.size_bytes,
    }));
    if (items.length === 0) return "(empty inbox)";
    return JSON.stringify({ inbox: inboxAddress, items });
  } catch (error) {
    return formatErr(error);
  }
}

export const cfEmailReadCoreSchema = z.object({
  id: z.string().min(1),
});
export type CfEmailReadCoreInput = z.infer<typeof cfEmailReadCoreSchema>;

export async function runCfEmailRead(
  input: CfEmailReadCoreInput & { sessionId: string },
  env: Env,
): Promise<string> {
  const db = env.DB;
  if (!db) return "error: DB binding not configured";
  try {
    const row = await db
      .prepare(
        `SELECT message_id, from_addr, to_addr, subject, received_at_ms, size_bytes,
                body_text, body_html
         FROM inbox
         WHERE session_id = ? AND message_id = ?`,
      )
      .bind(input.sessionId, input.id)
      .first<InboxBodyRow>();
    if (!row)
      return `error: message ${input.id} not found in this session's inbox`;
    const body = row.body_text ?? row.body_html ?? "(no body)";
    return JSON.stringify({
      id: row.message_id,
      from: row.from_addr,
      to: row.to_addr,
      subject: row.subject,
      receivedAt: new Date(row.received_at_ms).toISOString(),
      sizeBytes: row.size_bytes,
      format: row.body_text ? "text" : row.body_html ? "html" : "empty",
      body: truncate(body),
    });
  } catch (error) {
    return formatErr(error);
  }
}
