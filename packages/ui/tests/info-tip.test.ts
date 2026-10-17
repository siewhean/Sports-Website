import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INFO_TIP_CLOSE_DELAY_MS,
  INFO_TIP_OPEN_DELAY_MS,
  createInfoTipController,
  type InfoTipState,
} from "../src/react/index.js";

function setup(initial?: InfoTipState) {
  const changes: InfoTipState[] = [];
  const controller = createInfoTipController({ initial, onChange: (state) => changes.push(state) });
  return { controller, changes };
}

describe("InfoTip interaction controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens on mouse hover only after the open delay", () => {
    const { controller } = setup();
    controller.pointerEnter("mouse");
    vi.advanceTimersByTime(INFO_TIP_OPEN_DELAY_MS - 1);
    expect(controller.state.open).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.state).toEqual({ open: true, pinned: false });
  });

  it("does not open when the mouse passes over and leaves before the delay", () => {
    const { controller } = setup();
    controller.pointerEnter("mouse");
    vi.advanceTimersByTime(INFO_TIP_OPEN_DELAY_MS - 50);
    controller.pointerLeave("mouse");
    vi.advanceTimersByTime(1000);
    expect(controller.state.open).toBe(false);
  });

  it("stays open while the mouse moves from the button into the panel", () => {
    const { controller } = setup();
    controller.pointerEnter("mouse");
    vi.advanceTimersByTime(INFO_TIP_OPEN_DELAY_MS);
    // Crossing the gap between button and panel briefly leaves the tip.
    controller.pointerLeave("mouse");
    vi.advanceTimersByTime(INFO_TIP_CLOSE_DELAY_MS - 50);
    controller.pointerEnter("mouse");
    vi.advanceTimersByTime(1000);
    expect(controller.state.open).toBe(true);
  });

  it("closes after the close delay once the mouse leaves", () => {
    const { controller } = setup();
    controller.pointerEnter("mouse");
    vi.advanceTimersByTime(INFO_TIP_OPEN_DELAY_MS);
    controller.pointerLeave("mouse");
    vi.advanceTimersByTime(INFO_TIP_CLOSE_DELAY_MS - 1);
    expect(controller.state.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controller.state.open).toBe(false);
  });

  it("pins a hover-opened tip when it is clicked instead of closing it", () => {
    const { controller } = setup();
    controller.pointerEnter("mouse");
    vi.advanceTimersByTime(INFO_TIP_OPEN_DELAY_MS);
    controller.activate();
    expect(controller.state).toEqual({ open: true, pinned: true });
    controller.pointerLeave("mouse");
    vi.advanceTimersByTime(1000);
    expect(controller.state.open).toBe(true);
    controller.activate();
    expect(controller.state.open).toBe(false);
  });

  it("a click before the hover delay opens and pins once, without a later double toggle", () => {
    const { controller, changes } = setup();
    controller.pointerEnter("mouse");
    controller.activate();
    vi.advanceTimersByTime(1000);
    expect(controller.state).toEqual({ open: true, pinned: true });
    expect(changes).toHaveLength(1);
  });

  it("ignores touch and pen hover; a tap toggles", () => {
    const { controller } = setup();
    controller.pointerEnter("touch");
    vi.advanceTimersByTime(1000);
    expect(controller.state.open).toBe(false);
    controller.activate();
    expect(controller.state.open).toBe(true);
    controller.pointerLeave("touch");
    vi.advanceTimersByTime(1000);
    expect(controller.state.open).toBe(true);
    controller.activate();
    expect(controller.state.open).toBe(false);
  });

  it("keyboard Enter/Space activation toggles and Escape dismisses", () => {
    // Enter and Space reach the controller as native button clicks.
    const { controller } = setup();
    controller.activate();
    expect(controller.state.open).toBe(true);
    controller.activate();
    expect(controller.state.open).toBe(false);
    controller.activate();
    controller.dismiss();
    expect(controller.state).toEqual({ open: false, pinned: false });
  });

  it("focus leaving closes a hover-opened tip but not a pinned one", () => {
    const hovered = setup().controller;
    hovered.pointerEnter("mouse");
    vi.advanceTimersByTime(INFO_TIP_OPEN_DELAY_MS);
    hovered.focusOut();
    expect(hovered.state.open).toBe(false);

    const pinned = setup().controller;
    pinned.activate();
    pinned.focusOut();
    expect(pinned.state.open).toBe(true);
  });

  it("dismiss cancels a pending hover open and dispose clears timers", () => {
    const { controller, changes } = setup();
    controller.pointerEnter("mouse");
    controller.dismiss();
    vi.advanceTimersByTime(1000);
    expect(controller.state.open).toBe(false);

    controller.pointerEnter("mouse");
    controller.dispose();
    vi.advanceTimersByTime(1000);
    expect(changes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts from defaultOpen as pinned", () => {
    const { controller } = setup({ open: true, pinned: true });
    controller.pointerLeave("mouse");
    vi.advanceTimersByTime(1000);
    expect(controller.state.open).toBe(true);
  });
});
