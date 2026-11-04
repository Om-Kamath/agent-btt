import { useEffect, useMemo, useRef, useState } from "react";
import { visualDocument } from "./lib";
import type { Visual } from "./types";

interface Props {
  visual: Visual;
  onFailure(error: string): void;
}

let diagramCount = 0;

function MermaidView({ code, onFailure }: { code: string; onFailure(error: string): void }) {
  const [svg, setSvg] = useState("");
  const failure = useRef(onFailure);
  failure.current = onFailure;

  useEffect(() => {
    let current = true;
    const id = `diagram-${++diagramCount}`;
    (async () => {
      const { default: mermaid } = await import("mermaid");
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
        themeVariables: dark
          ? { background: "transparent", primaryColor: "#2F4A47", primaryTextColor: "#F5F5F7", primaryBorderColor: "#7FC4B8", lineColor: "#A1A1A6", secondaryColor: "#3A3A3C", tertiaryColor: "#2C2C2E", fontSize: "14px" }
          : { background: "transparent", primaryColor: "#E6F0EE", primaryTextColor: "#1D1D1F", primaryBorderColor: "#2F6F6B", lineColor: "#6E6E73", secondaryColor: "#F1F3F2", tertiaryColor: "#FFFFFF", fontSize: "14px" },
      });
      try {
        const result = await mermaid.render(id, code);
        if (current) setSvg(result.svg);
      } catch (error) {
        document.getElementById(`d${id}`)?.remove();
        if (current) failure.current(String(error));
      }
    })();
    return () => {
      current = false;
    };
  }, [code]);

  return <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function HtmlView({ code, onFailure }: { code: string; onFailure(error: string): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const failure = useRef(onFailure);
  failure.current = onFailure;
  const document_ = useMemo(() => visualDocument(code), [code]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data?.margin === "height") setHeight(Math.min(640, Math.max(80, Number(e.data.height) || 0)));
      if (e.data?.margin === "error") failure.current(String(e.data.message));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={frame}
      className="visual-frame"
      title="Interactive visual"
      sandbox="allow-scripts"
      srcDoc={document_}
      style={{ height }}
    />
  );
}

export function VisualView({ visual, onFailure }: Props) {
  return (
    <figure className="visual">
      {visual.form === "mermaid" ? (
        <MermaidView code={visual.code} onFailure={onFailure} />
      ) : (
        <HtmlView code={visual.code} onFailure={onFailure} />
      )}
      {visual.caption && <figcaption>{visual.caption}</figcaption>}
    </figure>
  );
}
