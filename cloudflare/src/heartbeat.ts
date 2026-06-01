import type Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_BETA } from "./anthropic";

// Hand-rolled work-item heartbeat loop, shared by both Sandbox
// backends. The platform-recommended pattern (see Anthropic's
// self-hosted-sandboxes docs) is to delegate this to either
// `EnvironmentWorker.handleItem()` (Node SDK) or `ant beta:worker run`
// (CLI), both of which own claim → heartbeat → dispatch → stop in one
// process. Neither helper runs in a Cloudflare Worker DO (the SDK
// helper needs Node + `/bin/bash`; the CLI is a separate process), so
// we own the protocol ourselves and compose it alongside our DO-side
// event-stream dispatcher.
//
// Protocol (see `WorkHeartbeatParams` in the SDK types):
//   - First heartbeat sends `expected_last_heartbeat: "NO_HEARTBEAT"`
//     to claim an unclaimed lease.
//   - Each subsequent heartbeat echoes back the server's previous
//     `last_heartbeat` value for optimistic concurrency. A 412 means
//     someone else claimed the lease — bail and let the next webhook
//     reclaim.
//   - The response's `state` tells us when the platform wants the work
//     item to stop (`stopping` / `stopped`); abort the shared
//     controller so the dispatcher unwinds.

// 20s gives the lease ~3x headroom against the server's default 60s
// TTL — same headroom the SDK's `EnvironmentWorker` uses internally.
export const HEARTBEAT_INTERVAL_MS = 20_000;

export interface HeartbeatLoopOpts {
  client: Anthropic;
  workId: string;
  environmentId: string;
  // Aborted by the caller's outer controller (so a manual stop or a
  // session-terminated event winds the loop down) and also written to
  // via `abort()` when the platform tells us to stop. Both directions
  // use the same controller so the dispatcher and heartbeat tear down
  // together.
  signal: AbortSignal;
  abort: () => void;
  // Tag for log lines so output from MicroVM vs Isolate stays
  // greppable.
  logPrefix: string;
}

export async function runHeartbeatLoop(opts: HeartbeatLoopOpts): Promise<void> {
  let lastHeartbeat: string | null = null;
  while (!opts.signal.aborted) {
    try {
      const response = await opts.client.beta.environments.work.heartbeat(
        opts.workId,
        {
          environment_id: opts.environmentId,
          expected_last_heartbeat: lastHeartbeat ?? "NO_HEARTBEAT",
          betas: [ANTHROPIC_BETA],
        },
        { signal: opts.signal },
      );
      lastHeartbeat = response.last_heartbeat;
      if (response.state === "stopping" || response.state === "stopped") {
        console.log(
          `${opts.logPrefix} heartbeat state=${response.state} work=${opts.workId} — aborting runner`,
        );
        opts.abort();
        return;
      }
      if (!response.lease_extended) {
        console.warn(
          `${opts.logPrefix} heartbeat lease not extended work=${opts.workId} — aborting runner`,
        );
        opts.abort();
        return;
      }
    } catch (error) {
      if (opts.signal.aborted) return;
      // 4xx generally is fatal — 412 (precondition failed) in particular
      // means our `expected_last_heartbeat` didn't match and the lease
      // moved on without us. Abort and let the next webhook reclaim.
      const status = (error as { status?: number })?.status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        console.warn(
          `${opts.logPrefix} heartbeat ${status} work=${opts.workId} — aborting runner: ${errStr(error)}`,
        );
        opts.abort();
        return;
      }
      console.warn(
        `${opts.logPrefix} heartbeat transient error work=${opts.workId}: ${errStr(error)}`,
      );
      // Fall through to the sleep; retry on the next tick.
    }
    await sleep(HEARTBEAT_INTERVAL_MS, opts.signal);
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
