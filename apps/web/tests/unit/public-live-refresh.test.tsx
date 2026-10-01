import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  effect: undefined as undefined | (() => undefined | (() => void)),
  setConnection: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => undefined | (() => void)) => {
    hooks.effect = effect;
  },
  useState: () => ["reconnecting", hooks.setConnection],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: hooks.refresh }) }));
import { PublicLiveRefresh } from "../../components/phase2/PublicLiveRefresh";

class Source {
  static instances: Source[] = [];
  listeners = new Map<string, (event: { data: string }) => void>();
  onerror: undefined | (() => void);
  close = vi.fn();
  constructor(readonly url: string) {
    Source.instances.push(this);
  }
  addEventListener(name: string, listener: (event: { data: string }) => void) {
    this.listeners.set(name, listener);
  }
  emit(name: string, data = "{}") {
    this.listeners.get(name)?.({ data });
  }
}
let cleanup: undefined | (() => void);
let online: undefined | (() => void);
const removeEventListener = vi.fn();
function mount(slug = "national-open") {
  PublicLiveRefresh({ slug });
  cleanup = hooks.effect!() || undefined;
  return Source.instances.at(-1)!;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Source.instances = [];
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("window", {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    addEventListener: (_name: string, listener: () => void) => {
      online = listener;
    },
    removeEventListener,
  });
});
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("public live connection", () => {
  it("keeps unchanged results connected through heartbeats without repeatedly refreshing", async () => {
    const source = mount("national open");
    expect(source.url).toContain("national%20open/versions");
    source.emit("version", '"4:7:3"');
    for (let tick = 0; tick < 15; tick++) {
      await vi.advanceTimersByTimeAsync(2_000);
      source.emit("heartbeat");
    }
    expect(hooks.setConnection).not.toHaveBeenCalledWith("stale");
    expect(hooks.setConnection).toHaveBeenLastCalledWith("connected");
    expect(hooks.refresh).not.toHaveBeenCalled();
    source.emit("version", '"4:8:4"');
    expect(hooks.refresh).toHaveBeenCalledTimes(1);
    source.emit("version", '"4:8:4"');
    expect(hooks.refresh).toHaveBeenCalledTimes(1);
  });

  it("uses polling recovery when contact stops and handles reconnect/unavailable/online", async () => {
    const source = mount();
    source.emit("version", '"4:7:3"');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(hooks.setConnection).toHaveBeenLastCalledWith("stale");
    expect(hooks.refresh).toHaveBeenCalledTimes(1);
    source.emit("reconnect");
    expect(hooks.setConnection).toHaveBeenLastCalledWith("reconnecting");
    source.emit("unavailable");
    expect(hooks.setConnection).toHaveBeenLastCalledWith("stale");
    source.onerror!();
    online!();
    expect(hooks.setConnection).toHaveBeenLastCalledWith("reconnecting");
    expect(hooks.refresh).toHaveBeenCalledTimes(2);
  });

  it("contains malformed frames and resets version comparison when the competition changes", () => {
    const first = mount();
    expect(() => first.emit("version", "not JSON")).not.toThrow();
    first.emit("version", '"4:7:3"');
    cleanup!();
    const second = mount("other-competition");
    second.emit("version", '"1:1:1"');
    expect(hooks.refresh).not.toHaveBeenCalled();
    cleanup!();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith("online", online);
    expect(vi.getTimerCount()).toBe(0);
    cleanup = undefined;
  });
});
