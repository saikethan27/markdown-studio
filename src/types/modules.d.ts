declare module "markdown-it";
declare module "markdown-it-footnote";
declare module "markdown-it-katex";
declare module "markdown-it-task-lists";
declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";
  const full: MarkdownIt.PluginSimple;
  const light: MarkdownIt.PluginSimple;
  export { full, light };
}
