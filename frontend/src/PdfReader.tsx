import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { findCitations, findTerms, hitTest, selectionRects } from "./lib";
import type { GuideTerm, Highlight, PageMarks } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
(globalThis as any).pdfjsLib = pdfjs;

const PDF_TO_CSS = 96 / 72;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface SelectionInfo {
  text: string;
  page: number;
  marks: PageMarks[];
  anchor: { left: number; top: number; bottom: number; width: number };
}

export interface TextAnchor { left: number; top: number; bottom: number }
export interface CitationClick { numbers: number[]; page: number; marker: string; line: string; anchor: TextAnchor }

export interface ReaderHandle {
  goToPage(page: number): void;
  goToMark(page: number, y: number): void;
  zoom(factor: number): void;
  clearSelection(): void;
}

interface Props {
  url: string;
  highlights: Highlight[];
  activeId: string | null;
  terms: GuideTerm[];
  references: number[];
  onTerm(term: GuideTerm | null, anchor: TextAnchor | null): void;
  onCitation(click: CitationClick): void;
  onSelection(info: SelectionInfo | null): void;
  onOpenHighlight(id: string): void;
  onPage(page: number): void;
  onFailure(message: string): void;
}

/** One line of the PDF's text layer, which pdf.js may split into several spans. */
interface TextRun { text: string; nodes: { node: Text; start: number }[]; page: number }

function textRunAt(x: number, y: number): TextRun | null {
  const span = document.elementsFromPoint(x, y).find(
    (el) => el.tagName === "SPAN" && el.closest(".textLayer") && el.firstChild?.nodeType === Node.TEXT_NODE,
  );
  const pageEl = span?.closest<HTMLElement>(".page");
  if (!span || !pageEl) return null;
  let first: Element = span;
  while (first.previousElementSibling?.tagName === "SPAN") first = first.previousElementSibling;
  const run: TextRun = { text: "", nodes: [], page: Number(pageEl.dataset.pageNumber) };
  for (let el: Element | null = first; el?.tagName === "SPAN"; el = el.nextElementSibling) {
    if (el.firstChild?.nodeType !== Node.TEXT_NODE) continue;
    const node = el.firstChild as Text;
    run.nodes.push({ node, start: run.text.length });
    run.text += node.data;
  }
  return run;
}

function runBoxes(run: TextRun, start: number, end: number): DOMRect[] {
  const boxes: DOMRect[] = [];
  for (const { node, start: from } of run.nodes) {
    const low = Math.max(start, from);
    const high = Math.min(end, from + node.data.length);
    if (low >= high) continue;
    const range = document.createRange();
    range.setStart(node, low - from);
    range.setEnd(node, high - from);
    boxes.push(...range.getClientRects());
  }
  return boxes;
}

/** The first match whose text is under the pointer, with where it is on screen. */
function matchAt<M extends { start: number; end: number }>(run: TextRun, matches: M[], x: number, y: number) {
  for (const match of matches) {
    const boxes = runBoxes(run, match.start, match.end);
    if (boxes.some((b) => x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1)) {
      const anchor: TextAnchor = { left: boxes[0].left, top: boxes[0].top, bottom: boxes[boxes.length - 1].bottom };
      return { match, anchor };
    }
  }
  return null;
}

function sheetWidth(): number {
  if (window.innerWidth < 760) return 0;
  return Math.min(520, Math.max(360, window.innerWidth * 0.36));
}

function paintMarks(root: HTMLElement, highlights: Highlight[], activeId: string | null, cutId: string | null) {
  for (const pageEl of root.querySelectorAll<HTMLElement>(".page")) {
    const number = Number(pageEl.dataset.pageNumber);
    let svg = pageEl.querySelector<SVGSVGElement>(":scope > svg.marks");
    if (!svg) {
      svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "marks");
      svg.setAttribute("aria-hidden", "true");
      pageEl.append(svg);
    }
    const rect = (r: { x: number; y: number; w: number; h: number }, attrs: string) =>
      `<rect x="${r.x * 100}%" y="${r.y * 100}%" width="${r.w * 100}%" height="${r.h * 100}%" rx="2" ${attrs}/>`;
    const rectsFor = (h: Highlight) => h.marks.filter((m) => m.page === number).flatMap((m) => m.rects);
    const cut = highlights.find((h) => h.id === cutId);
    const holes = cut ? rectsFor(cut).map((r) => rect(r, 'fill="black"')).join("") : "";
    const marks = highlights
      .flatMap((h) => rectsFor(h).map((r) => rect(r, `class="mark${h.id === activeId ? " active" : ""}"`)))
      .join("");
    svg.innerHTML =
      `<mask id="cut-${number}"><rect width="100%" height="100%" fill="white"/>${holes}</mask>` +
      `<rect class="veil" width="100%" height="100%" mask="url(#cut-${number})"/>${marks}`;
  }
}

export const PdfReader = forwardRef<ReaderHandle, Props>(function PdfReader(props, ref) {
  const { url, highlights, activeId } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const latest = useRef(props);
  latest.current = props;
  const cutId = useRef<string | null>(null);
  const preferredScale = useRef(1);
  const pageWidth = useRef(0);

  const repaint = () => {
    if (containerRef.current) {
      paintMarks(containerRef.current, latest.current.highlights, latest.current.activeId, cutId.current);
    }
  };

  useImperativeHandle(ref, () => ({
    goToPage(page) {
      if (viewerRef.current) viewerRef.current.currentPageNumber = page;
    },
    goToMark(page, y) {
      const container = containerRef.current;
      const pageEl = container?.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`);
      if (container && pageEl) container.scrollTop = pageEl.offsetTop + y * pageEl.offsetHeight - 96;
    },
    zoom(factor) {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.currentScale = Math.min(3, Math.max(0.5, viewer.currentScale * factor));
      preferredScale.current = viewer.currentScale;
    },
    clearSelection() {
      window.getSelection()?.removeAllRanges();
    },
  }));

  // Load the document and create the viewer.
  useEffect(() => {
    let cancelled = false;
    let task: any;
    (async () => {
      const { PDFViewer, EventBus, PDFLinkService } = await import("pdfjs-dist/web/pdf_viewer.mjs");
      if (cancelled) return;
      const eventBus = new EventBus();
      const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 });
      const viewer = new PDFViewer({
        container: containerRef.current!,
        viewer: viewerElRef.current!,
        eventBus,
        linkService,
        removePageBorders: true,
      });
      linkService.setViewer(viewer);
      viewerRef.current = viewer;
      eventBus.on("pagesinit", async () => {
        const first = await viewer.pdfDocument!.getPage(1);
        const width = first.getViewport({ scale: 1 }).width * PDF_TO_CSS;
        const room = window.innerWidth - sheetWidth() - (window.innerWidth < 760 ? 16 : 64);
        viewer.currentScale = Math.min(1.4, Math.max(0.4, room / width));
        preferredScale.current = viewer.currentScale;
        pageWidth.current = width;
        repaint();
      });
      eventBus.on("pagerendered", repaint);
      eventBus.on("pagechanging", (e: any) => latest.current.onPage(e.pageNumber));

      task = pdfjs.getDocument({ url });
      const doc = await task.promise;
      if (cancelled) return;
      viewer.setDocument(doc);
      linkService.setDocument(doc);
    })().catch((error) => {
      if (!cancelled) {
        console.error(error);
        latest.current.onFailure("This PDF couldn't be displayed. Open it again.");
      }
    });
    return () => {
      cancelled = true;
      task?.destroy();
      viewerRef.current = null;
    };
  }, [url]);

  // Keeps the page fitting when a panel opens beside it, and restores its size when the panel closes.
  useEffect(() => {
    const container = containerRef.current!;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const viewer = viewerRef.current;
        if (!viewer || !pageWidth.current) return;
        const fit = (container.clientWidth - 32) / pageWidth.current;
        const next = Math.max(0.4, Math.min(preferredScale.current, fit));
        if (Math.abs(next - viewer.currentScale) > 0.01) viewer.currentScale = next;
      }, 480);
    });
    observer.observe(container);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  // Definitions on hover, and citations on click.
  useEffect(() => {
    const container = containerRef.current!;
    let frame = 0;
    let shown: string | null = null;
    const citationAt = (x: number, y: number) => {
      const run = textRunAt(x, y);
      if (!run || !latest.current.references.length) return null;
      const hit = matchAt(run, findCitations(run.text, latest.current.references), x, y);
      return hit && { ...hit, run };
    };
    const settle = (term: GuideTerm | null, anchor: TextAnchor | null, cursor: string) => {
      container.dataset.over = cursor;
      if ((term?.term ?? null) !== shown) {
        shown = term?.term ?? null;
        latest.current.onTerm(term, anchor);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const { clientX: x, clientY: y, buttons } = e;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (buttons || !window.getSelection()?.isCollapsed) return settle(null, null, "");
        if (citationAt(x, y)) return settle(null, null, "citation");
        const run = textRunAt(x, y);
        const hit = run && matchAt(run, findTerms(run.text, latest.current.terms), x, y);
        if (hit) settle(hit.match.term, hit.anchor, "term");
        else settle(null, null, "");
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      settle(null, null, "");
    };
    // Runs before pdf.js follows the PDF's own link, which would jump away from the sentence being read.
    const onClickCapture = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const hit = citationAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onCitation({
        numbers: hit.match.numbers, page: hit.run.page, marker: hit.match.raw, line: hit.run.text.slice(0, 1000), anchor: hit.anchor,
      });
    };
    container.addEventListener("pointermove", onMove, { passive: true });
    container.addEventListener("pointerleave", onLeave);
    container.addEventListener("scroll", onLeave, { passive: true });
    container.addEventListener("click", onClickCapture, true);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("scroll", onLeave);
      container.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  // Highlights and the focus veil.
  useEffect(() => {
    if (activeId) cutId.current = activeId;
    repaint();
    const frame = requestAnimationFrame(() => {
      containerRef.current?.classList.toggle("focused", Boolean(activeId));
    });
    return () => cancelAnimationFrame(frame);
  }, [highlights, activeId]);

  // Selection.
  useEffect(() => {
    const container = containerRef.current!;

    const read = (): SelectionInfo | null => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
      const text = selection.toString().replace(/\s+/g, " ").trim();
      if (text.length < 2) return null;
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return null;
      const clientRects = [...range.getClientRects()];
      const marks: PageMarks[] = [];
      for (const pageEl of container.querySelectorAll<HTMLElement>(".page")) {
        if (!range.intersectsNode(pageEl)) continue;
        const bounds = pageEl.getBoundingClientRect();
        const inside = clientRects.filter((r) => {
          const y = r.top + r.height / 2;
          return y >= bounds.top && y <= bounds.bottom;
        });
        const rects = selectionRects(inside, bounds);
        if (rects.length) marks.push({ page: Number(pageEl.dataset.pageNumber), rects });
      }
      if (!marks.length) return null;
      const box = range.getBoundingClientRect();
      return {
        text,
        page: marks[0].page,
        marks,
        anchor: { left: box.left, top: box.top, bottom: box.bottom, width: box.width },
      };
    };

    const publish = () => latest.current.onSelection(read());
    const onPointerUp = () => setTimeout(publish, 0);
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed) latest.current.onSelection(null);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey) publish();
    };
    const onClick = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".page");
      if (!pageEl) return;
      const bounds = pageEl.getBoundingClientRect();
      const marks = latest.current.highlights.flatMap((h) => h.marks.map((m) => ({ id: h.id, ...m })));
      const hit = hitTest(
        marks,
        Number(pageEl.dataset.pageNumber),
        (e.clientX - bounds.left) / bounds.width,
        (e.clientY - bounds.top) / bounds.height,
      );
      if (hit) latest.current.onOpenHighlight(hit);
    };
    const onScroll = () => {
      if (!window.getSelection()?.isCollapsed) publish();
    };

    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("click", onClick);
    container.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("click", onClick);
      container.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <div className="reader" ref={containerRef}>
      <div className="pdfViewer" ref={viewerElRef} />
    </div>
  );
});
