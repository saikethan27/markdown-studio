import hljs from "highlight.js/lib/core";

/**
 * Lazy highlight.js loader.
 *
 * `require("highlight.js")` pulls in `lib/index.js`, which eagerly registers all
 * 192 bundled grammars — 194 file loads and ~190ms even with a warm file cache.
 * Almost none of them are ever used. We import `lib/core` instead (~3ms) and
 * register a grammar the first time a fence actually asks for it.
 *
 * `hljs.registerLanguage` also registers the grammar's own aliases, so once
 * `javascript` is loaded, `getLanguage("js")` resolves on its own. The first
 * lookup for an alias has nothing registered yet, so ALIASES maps it back to the
 * module name to require.
 */

/**
 * Alias → canonical grammar module name, for aliases that cannot be resolved by
 * filename alone (`js` lives in `javascript.js`).
 *
 * AUTO-GENERATED against highlight.js 11.11.1. To regenerate:
 *
 *   node -e "const h=require('highlight.js');const a={};for(const n of h.listLanguages())
 *     for(const x of (h.getLanguage(n).aliases||[])) if(x!==n) a[x]=n;
 *     console.log(JSON.stringify(a,null,2))"
 */
const ALIASES: Record<string, string> = {
  "ado": "stata", "adoc": "asciidoc", "ahk": "autohotkey", "apacheconf": "apache", "arm": "armasm",
  "as": "actionscript", "asc": "angelscript", "atom": "xml", "bat": "dos", "bf": "brainfuck",
  "bind": "dns", "c#": "csharp", "c++": "cpp", "capnp": "capnproto", "cc": "cpp",
  "cjs": "javascript", "clj": "clojure", "cls": "cos", "cmake.in": "cmake", "cmd": "dos",
  "coffee": "coffeescript", "console": "shell", "cr": "crystal", "craftcms": "twig", "crm": "crmsh",
  "cs": "csharp", "cson": "coffeescript", "cts": "typescript", "cxx": "cpp", "dcl": "clean",
  "dfm": "delphi", "do": "stata", "docker": "dockerfile", "dpr": "delphi", "dst": "dust",
  "edn": "clojure", "erl": "erlang", "ex": "elixir", "exs": "elixir", "f#": "fsharp",
  "f90": "fortran", "f95": "fortran", "feature": "gherkin", "fs": "fsharp", "gemspec": "ruby",
  "gms": "gams", "golang": "go", "gql": "graphql", "graph": "roboconf", "gss": "gauss",
  "gyp": "python", "h": "c", "h++": "cpp", "hbs": "handlebars", "hh": "cpp",
  "hpp": "cpp", "hs": "haskell", "html": "xml", "html.handlebars": "handlebars", "html.hbs": "handlebars",
  "htmlbars": "handlebars", "https": "http", "hx": "haxe", "hxx": "cpp", "hylang": "hy",
  "i7": "inform7", "iced": "coffeescript", "icl": "clean", "ino": "arduino", "instances": "roboconf",
  "ipython": "python", "irb": "ruby", "jinja": "django", "jldoctest": "julia-repl", "js": "javascript",
  "jsonc": "json", "jsp": "java", "jsx": "javascript", "k": "q", "kdb": "q",
  "kt": "kotlin", "kts": "kotlin", "lassoscript": "lasso", "ls": "livescript", "m": "mercury",
  "mak": "makefile", "make": "makefile", "md": "markdown", "mikrotik": "routeros", "mips": "mipsasm",
  "mjs": "javascript", "mk": "makefile", "mkd": "markdown", "mkdown": "markdown", "ml": "sml",
  "mm": "objectivec", "mma": "mathematica", "moo": "mercury", "moon": "moonscript", "mts": "typescript",
  "nc": "gcode", "nginxconf": "nginx", "nixos": "nix", "nt": "nestedtext", "obj-c": "objectivec",
  "obj-c++": "objectivec", "objc": "objectivec", "objective-c++": "objectivec", "osascript": "applescript", "p21": "step21",
  "pas": "delphi", "pascal": "delphi", "patch": "diff", "pb": "purebasic", "pbi": "purebasic",
  "pcmk": "crmsh", "pde": "processing", "pf.conf": "pf", "pl": "perl", "plist": "xml",
  "pluto": "lua", "pm": "perl", "podspec": "ruby", "postgres": "pgsql", "postgresql": "pgsql",
  "pp": "puppet", "proto": "protobuf", "ps": "powershell", "ps1": "powershell", "pwsh": "powershell",
  "py": "python", "pycon": "python-repl", "qt": "qml", "rb": "ruby", "re": "reasonml",
  "rs": "rust", "rss": "xml", "scad": "openscad", "sci": "scilab", "scm": "scheme",
  "sh": "bash", "shellsession": "shell", "st": "smalltalk", "stanfuncs": "stan", "step": "step21",
  "stp": "step21", "styl": "stylus", "sv": "verilog", "svg": "xml", "svh": "verilog",
  "tao": "xl", "tex": "latex", "text": "plaintext", "thor": "ruby", "tk": "tcl",
  "toml": "ini", "ts": "typescript", "tsx": "typescript", "txt": "plaintext", "v": "verilog",
  "vb": "vbnet", "vbs": "vbscript", "wildfly-cli": "jboss-cli", "wl": "mathematica", "wsf": "xml",
  "x++": "axapta", "xhtml": "xml", "xjb": "xml", "xls": "excel", "xlsx": "excel",
  "xpath": "xquery", "xq": "xquery", "xqm": "xquery", "xsd": "xml", "xsl": "xml",
  "yml": "yaml", "zep": "zephir", "zone": "dns", "zsh": "bash"
};

/** Grammar module names we have already tried to load (successfully or not). */
const attempted = new Set<string>();

/**
 * Ensure the grammar for `language` is registered, loading it on first use.
 * Returns true when highlight.js can highlight this language.
 */
export function ensureLanguage(language: string): boolean {
  if (!language) {
    return false;
  }

  // Already registered — either loaded earlier, or an alias of a loaded grammar.
  if (hljs.getLanguage(language)) {
    return true;
  }

  const moduleName = ALIASES[language] ?? language;
  if (attempted.has(moduleName)) {
    return Boolean(hljs.getLanguage(language));
  }
  attempted.add(moduleName);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const grammar = require(`highlight.js/lib/languages/${moduleName}`);
    hljs.registerLanguage(moduleName, grammar.default ?? grammar);
  } catch {
    return false; // unknown language — caller falls back to plain escaped code
  }

  return Boolean(hljs.getLanguage(language));
}

/** Highlight `code` as `language`. Only call after `ensureLanguage` returns true. */
export function highlight(code: string, language: string): string {
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
