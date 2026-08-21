import { afterEach, describe, expect, it, vi } from "vitest";
import { GateCC3BoundedBuffer, GateCC3ProxyFaultRegistry } from "../../scripts/gate-c-c3-proxy-faults.js";

describe("Gate C3 proxy fault registry", () => {
  afterEach(() => vi.useRealTimers());

  it("expires and releases a held request", () => {
    vi.useFakeTimers();
    const registry = new GateCC3ProxyFaultRegistry(100);
    const release = vi.fn();
    expect(registry.armHeld("scope-a", "event-a", "hold_request")).toBe(true);
    expect(registry.markHeld("scope-a", release)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(release).toHaveBeenCalledOnce();
    expect(registry.held("scope-a")).toBeUndefined();
  });

  it("disposes every active held request without waiting for its TTL", () => {
    vi.useFakeTimers();
    const registry = new GateCC3ProxyFaultRegistry();
    const release = vi.fn();
    registry.armHeld("scope-a", "event-a", "hold_response");
    registry.markHeld("scope-a", release);
    registry.armHeld("scope-b", "event-b", "hold_request");
    registry.dispose();
    expect(release).toHaveBeenCalledOnce();
    expect(registry.hasActive("scope-a")).toBe(false);
    expect(registry.hasActive("scope-b")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes only the matching divergence and expires abandoned controls", () => {
    vi.useFakeTimers();
    const registry = new GateCC3ProxyFaultRegistry(100);
    expect(registry.armDivergence("scope-a", "event-a")).toBe(true);
    expect(registry.consumeDivergence("scope-a", "other-event")).toBe(false);
    expect(registry.consumeDivergence("scope-a", "event-a")).toBe(true);
    expect(registry.hasDivergence("scope-a")).toBe(false);
    expect(registry.armDivergence("scope-b", "event-b")).toBe(true);
    vi.advanceTimersByTime(100);
    expect(registry.hasDivergence("scope-b")).toBe(false);
  });

  it("rejects a held response as soon as its byte ceiling is exceeded", () => {
    const body = new GateCC3BoundedBuffer(4);
    expect(body.append(Buffer.from("ab"))).toBe(true);
    expect(body.append(Buffer.from("cd"))).toBe(true);
    expect(body.value().toString("utf8")).toBe("abcd");
    expect(body.append(Buffer.from("e"))).toBe(false);
    expect(() => body.value()).toThrow("Buffered response exceeded its limit.");
  });
});
