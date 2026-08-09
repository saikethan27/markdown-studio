import type { ExportRenderContext, RenderContext } from "./markdownRenderer";

/**
 * Lazy facade over the markdown renderer.
 *
 * `markdownRenderer` pulls in markdown-it, its four plugins, katex and
 * highlight.js. Statically importing it from `extension.ts` / the preview
 * classes made that whole graph load during `activate()` — hundreds of
 * milliseconds warm, over a second on a cold file cache — even though nothing
 * renders until the user actually opens a preview.
 *
 * Importing through this module keeps the graph off the activation path: the
 * `require` runs on the first render instead, and Node's module cache keeps
 * every later call free. `import type` above is erased at compile time, so it
 * adds no runtime edge.
 */

type RendererModule = typeof import("./markdownRenderer");

let loaded: RendererModule | undefined;

function renderer(): RendererModule {
  if (!loaded) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("./markdownRenderer") as RendererModule;
  }
  return loaded;
}

export function renderMarkdown(context: RenderContext): string {
  return renderer().renderMarkdown(context);
}

export function renderMarkdownForExport(context: ExportRenderContext): string {
  return renderer().renderMarkdownForExport(context);
}
