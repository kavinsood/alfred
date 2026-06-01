import { apiApp } from "./api";
import { IsolateRunner } from "./isolate/runner";
import { IsolateOutboundGateway } from "./isolate/gateway";
import { handleWebhook } from "./webhooks";
import { pruneOlderThan } from "./storage";

export { IsolateRunner, IsolateOutboundGateway };

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhooks" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return apiApp.fetch(request, env);
    }

    return new Response("alfred-cma control plane", { status: 200 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const cutoff = Date.now() - ONE_DAY_MS;
    ctx.waitUntil(
      (async () => {
        try {
          const result = await pruneOlderThan(env.DB, cutoff);
          console.log(
            `[cron] prune events=${result.events} sessions=${result.sessions} cutoff=${new Date(cutoff).toISOString()}`,
          );
        } catch (error) {
          console.error("[cron] prune failed", error);
        }
      })(),
    );
  },
};
