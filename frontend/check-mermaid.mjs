// Reads Mermaid from stdin and prints why it won't parse, using the same parser as the browser.
// It only parses and never draws, so the sanitizer, which needs a browser, can safely be a stand-in.
import DOMPurify from "dompurify";
import mermaid from "mermaid";

DOMPurify.addHook = () => {};
DOMPurify.removeHook = () => {};
DOMPurify.removeAllHooks = () => {};
DOMPurify.sanitize = (text) => text;

let code = "";
for await (const piece of process.stdin) code += piece;
try {
  await mermaid.parse(code);
} catch (error) {
  console.log(String(error.message ?? error));
  process.exit(1);
}
