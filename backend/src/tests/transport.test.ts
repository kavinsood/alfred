import { describe, it, expect } from "vitest";
import { getTransport } from "../transport.js";

describe("getTransport", () => {
  it("defaults to messages when no env var set", () => {
    expect(getTransport({})).toBe("messages");
  });

  it("accepts messages explicitly", () => {
    expect(getTransport({ ALFRED_TRANSPORT: "messages" })).toBe("messages");
  });

  it("accepts managed-agents", () => {
    expect(getTransport({ ALFRED_TRANSPORT: "managed-agents" })).toBe("managed-agents");
  });

  it("accepts legacy ALFRED_MODE=agents", () => {
    expect(getTransport({ ALFRED_MODE: "agents" })).toBe("managed-agents");
  });

  it("ALFRED_TRANSPORT takes priority over ALFRED_MODE", () => {
    expect(getTransport({ ALFRED_TRANSPORT: "messages", ALFRED_MODE: "agents" })).toBe("messages");
  });

  it("rejects invalid transport value", () => {
    expect(() => getTransport({ ALFRED_TRANSPORT: "cloudflare" })).toThrow(
      'Invalid ALFRED_TRANSPORT="cloudflare"'
    );
  });

  it("rejects empty string", () => {
    expect(() => getTransport({ ALFRED_TRANSPORT: "" })).toThrow("Invalid ALFRED_TRANSPORT");
  });
});
