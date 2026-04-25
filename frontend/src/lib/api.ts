import type {
  DecisionRequest,
  DecisionResponse,
  InspectRequest,
  InspectResponse,
  ProfileResponse,
  ProposeRequest,
  ProposeResponse,
  VoiceProfile,
} from "./types";

export type HealthInfo = {
  ok: boolean;
  service?: string;
  model?: string;
};

export async function getHealth(): Promise<HealthInfo> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return { ok: false };
    return (await res.json()) as HealthInfo;
  } catch {
    return { ok: false };
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function propose(req: ProposeRequest): Promise<ProposeResponse> {
  return postJson<ProposeResponse>("/api/propose", req);
}

export async function decide(req: DecisionRequest): Promise<DecisionResponse> {
  return postJson<DecisionResponse>("/api/decision", req);
}

export async function inspect(req: InspectRequest): Promise<InspectResponse> {
  return postJson<InspectResponse>("/api/inspect", req);
}

export async function getProfile(): Promise<ProfileResponse> {
  const res = await fetch("/api/profile");
  if (!res.ok) throw new Error(`profile fetch ${res.status}`);
  return (await res.json()) as ProfileResponse;
}

export async function putProfile(profile: VoiceProfile): Promise<{ ok: true }> {
  const res = await fetch("/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  if (!res.ok) throw new Error(`profile put ${res.status}`);
  return (await res.json()) as { ok: true };
}
