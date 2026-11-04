import { describe, expect, it } from "vitest";
import {
  hitTest,
  linkCitations,
  normalizeMath,
  selectionRects,
  SseParser,
  visualDocument,
} from "./lib";

const page = { left: 100, top: 200, width: 1000, height: 2000 };

describe("linkCitations", () => {
  it("turns a page citation into a jump link", () => {
    expect(linkCitations("True [p.4].")).toBe("True [p.4](#page-4).");
  });
  it("splits a citation naming several pages", () => {
    expect(linkCitations("True [p.4, p.7].")).toBe("True [p.4](#page-4), [p.7](#page-7).");
  });
  it("leaves existing links alone", () => {
    expect(linkCitations("[p.4](#page-4)")).toBe("[p.4](#page-4)");
  });
});

describe("normalizeMath", () => {
  it("converts bracket delimiters to dollars", () => {
    expect(normalizeMath("So \\(x^2\\) and \\[y\\].")).toBe("So $x^2$ and $$y$$.");
  });
});

describe("selectionRects", () => {
  it("converts to fractions of the page", () => {
    const [r] = selectionRects([{ left: 200, top: 400, width: 500, height: 20 }], page);
    expect(r).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.01 });
  });
  it("merges adjacent spans on a line into one rect", () => {
    const rects = selectionRects(
      [
        { left: 200, top: 400, width: 100, height: 20 },
        { left: 300, top: 402, width: 100, height: 16 },
      ],
      page,
    );
    expect(rects).toHaveLength(1);
    expect(rects[0].w).toBeCloseTo(0.2);
  });
  it("keeps separate lines separate", () => {
    const rects = selectionRects(
      [
        { left: 200, top: 400, width: 100, height: 20 },
        { left: 200, top: 430, width: 100, height: 20 },
      ],
      page,
    );
    expect(rects).toHaveLength(2);
  });
  it("drops empty rects and the page-tall rect the text layer can produce", () => {
    const rects = selectionRects(
      [
        { left: 200, top: 400, width: 100, height: 20 },
        { left: 200, top: 430, width: 100, height: 20 },
        { left: 200, top: 460, width: 0, height: 20 },
        { left: 100, top: 200, width: 1000, height: 1800 },
      ],
      page,
    );
    expect(rects).toHaveLength(2);
  });
});

describe("hitTest", () => {
  const marks = [{ id: "a", page: 2, rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.01 }] }];
  it("finds the highlight under a point on its page", () => {
    expect(hitTest(marks, 2, 0.2, 0.105)).toBe("a");
  });
  it("misses on another page or elsewhere on the page", () => {
    expect(hitTest(marks, 1, 0.2, 0.105)).toBeNull();
    expect(hitTest(marks, 2, 0.9, 0.105)).toBeNull();
  });
});

describe("SseParser", () => {
  it("parses events split across network chunks", () => {
    const parser = new SseParser();
    expect(parser.feed('data: {"type":"tok')).toEqual([]);
    expect(parser.feed('en"}\n\ndata: {"type":"done"}\n\n')).toEqual([{ type: "token" }, { type: "done" }]);
  });
});

describe("visualDocument", () => {
  const doc = visualDocument("<script>draw()</script>");
  it("puts a no-network content security policy before the model's code", () => {
    const policy = doc.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThan(-1);
    expect(doc).toContain("default-src 'none'");
    expect(policy).toBeLessThan(doc.indexOf("draw()"));
  });
  it("installs error reporting before the model's code", () => {
    expect(doc.indexOf("window.onerror")).toBeLessThan(doc.indexOf("draw()"));
  });
  it("defines the colours the illustrator is told to use", () => {
    for (const name of ["--ink", "--muted", "--line", "--accent", "--accent-soft", "--surface"]) {
      expect(doc).toContain(`${name}:`);
    }
  });
});
