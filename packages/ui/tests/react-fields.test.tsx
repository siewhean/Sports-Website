import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normaliseIntegerInput, parseIntegerInput } from "../src/index.js";
import {
  InfoTip,
  NumberField,
  fieldControlId,
  infoTipReducer,
  infoTipShift,
  withFieldControl,
} from "../src/react/index.js";

describe("InfoTip", () => {
  it("renders a labelled, collapsed disclosure button wired to its popover", () => {
    const html = renderToStaticMarkup(<InfoTip label="About match slot length">Time allocated per slot.</InfoTip>);
    const button = html.match(/<button[^>]*>/)?.[0] ?? "";
    const panel = html.match(/<span[^>]*role="note"[^>]*>/)?.[0] ?? "";
    const panelId = panel.match(/id="([^"]+)"/)?.[1];

    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label="About match slot length"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain(`aria-controls="${panelId}"`);
    expect(button).not.toContain("aria-describedby");
    expect(panelId).toMatch(/^infotip-[a-zA-Z0-9_-]+$/);
    expect(panel).toContain("hidden");
    expect(html).toContain('aria-hidden="true"');
  });

  it("describes the button by the popover only while open", () => {
    const html = renderToStaticMarkup(
      <InfoTip label="About reserve slots" defaultOpen>
        Slots held back for ceremonies.
      </InfoTip>,
    );
    const panelId = html
      .match(/role="note"[^>]*id="([^"]+)"|id="([^"]+)"[^>]*role="note"/)
      ?.slice(1)
      .find(Boolean);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`aria-describedby="${panelId}"`);
    expect(html).toContain('data-open="true"');
    expect(html).not.toMatch(/role="note"[^>]*hidden/);
    expect(html).toContain("Slots held back for ceremonies.");
  });

  it("gives every instance a unique popover id", () => {
    const html = renderToStaticMarkup(
      <>
        <InfoTip label="One">A</InfoTip>
        <InfoTip label="Two">B</InfoTip>
      </>,
    );
    const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it("uses a caller id for the popover so a field can stay described by a moved hint", () => {
    const html = renderToStaticMarkup(
      <InfoTip id="slug-hint" label="More about public address">
        Lowercase letters only.
      </InfoTip>,
    );
    expect(html).toContain('aria-controls="slug-hint"');
    expect(html).toMatch(/<span[^>]*id="slug-hint"[^>]*role="note"[^>]*hidden=""/);
  });

  it("toggles on activation and only closes on dismiss", () => {
    expect(infoTipReducer(false, "toggle")).toBe(true);
    expect(infoTipReducer(true, "toggle")).toBe(false);
    expect(infoTipReducer(true, "dismiss")).toBe(false);
    expect(infoTipReducer(false, "dismiss")).toBe(false);
  });

  it("keeps the popover inside a phone viewport with a 16px gutter", () => {
    expect(infoTipShift(100, 200, 375)).toBe(0);
    expect(infoTipShift(250, 300, 375)).toBe(375 - 16 - 550);
    expect(infoTipShift(4, 200, 375)).toBe(12);
    // Wider than the viewport: pin to the left gutter.
    expect(infoTipShift(200, 400, 375)).toBe(-184);
  });
});

describe("NumberField", () => {
  it("renders a numeric text field without spinner semantics", () => {
    const html = renderToStaticMarkup(<NumberField name="slot" value={30} onValueChange={() => undefined} />);
    expect(html).toContain('type="text"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('pattern="[0-9]*"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('value="30"');
  });

  it("supports uncontrolled form use with an empty or default value", () => {
    expect(renderToStaticMarkup(<NumberField name="seed" defaultValue={3} />)).toContain('value="3"');
    expect(renderToStaticMarkup(<NumberField name="planned" />)).toContain('value=""');
  });
});

describe("whole-number input helpers", () => {
  it("drops leading zeros and non-digits", () => {
    expect(normaliseIntegerInput("08")).toBe("8");
    expect(normaliseIntegerInput("010")).toBe("10");
    expect(normaliseIntegerInput("000")).toBe("0");
    expect(normaliseIntegerInput(" 1a2 ")).toBe("12");
    expect(normaliseIntegerInput("")).toBe("");
  });

  it("parses whole numbers or returns null", () => {
    expect(parseIntegerInput("010")).toBe(10);
    expect(parseIntegerInput("0")).toBe(0);
    expect(parseIntegerInput("")).toBeNull();
    expect(parseIntegerInput("abc")).toBeNull();
    expect(parseIntegerInput("99999999999999999999")).toBeNull();
  });
});

describe("field control wiring", () => {
  it("keeps an existing id and merges described-by ids", () => {
    const control = <input id="own" aria-describedby="hint" />;
    expect(fieldControlId(control, "fallback")).toBe("own");
    const html = renderToStaticMarkup(
      withFieldControl(control, { id: "own", describedBy: ["own-error", undefined], invalid: true }),
    );
    expect(html).toContain('id="own"');
    expect(html).toContain('aria-describedby="hint own-error"');
    expect(html).toContain('aria-invalid="true"');
  });

  it("falls back to the wrapper id and omits empty descriptions", () => {
    const control = <select />;
    expect(fieldControlId(control, "setup-sport-control")).toBe("setup-sport-control");
    const html = renderToStaticMarkup(withFieldControl(control, { id: "setup-sport-control" }));
    expect(html).toContain('id="setup-sport-control"');
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("aria-invalid");
  });
});
