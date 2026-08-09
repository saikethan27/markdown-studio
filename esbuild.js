// Production build: bundle the extension into a single file and copy the
// webview assets that are loaded from disk rather than required.
//
// Shipping an unbundled extension meant 5,488 files under node_modules and 243
// synchronous `require`s on the load path — over a second on a cold file cache,
// because each resolution is several syscalls that Defender inspects. One file
// is one read.
//
//   node esbuild.js                 dev build (sourcemaps, unminified)
//   node esbuild.js --production    shipping build (minified, no sourcemaps)
//   node esbuild.js --watch         dev build, rebuild on change
//   node esbuild.js --vendor-only   copy webview assets only
//
// tsc still writes out/ — it owns type checking and the test build (tests
// require out/ directly). Only dist/ is shipped.

const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");
const vendorOnly = process.argv.includes("--vendor-only");
const production = process.argv.includes("--production");
const root = __dirname;

// ── vendored webview assets ─────────────────────────────────────────────────
// KaTeX's CSS references its fonts as `fonts/…`, so the fonts directory has to
// stay a sibling of the stylesheet.
const VENDOR = [
  ["node_modules/katex/dist/katex.min.css", "media/vendor/katex/katex.min.css"],
  ["node_modules/katex/dist/fonts", "media/vendor/katex/fonts"],
  ["node_modules/mermaid/dist/mermaid.min.js", "media/vendor/mermaid/mermaid.min.js"]
];

function copyVendorAssets() {
  for (const [from, to] of VENDOR) {
    const src = path.join(root, from);
    const dest = path.join(root, to);

    if (!fs.existsSync(src)) {
      console.warn(`  ! missing ${from} — run npm install`);
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    console.log(`  vendored ${to}`);
  }
}

// ── bundle ──────────────────────────────────────────────────────────────────
const options = {
  entryPoints: [path.join(root, "src/extension.ts")],
  bundle: true,
  outfile: path.join(root, "dist/extension.js"),
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: production,
  // Sourcemaps keep F5 debugging landing in the .ts sources.
  sourcemap: !production,
  // `vscode` is supplied by the extension host, never bundled.
  //
  // highlight.js stays external on purpose: src/render/highlighter.ts requires
  // grammars by computed path so only the languages actually used get loaded.
  // A computed require cannot be bundled, so lib/ ships alongside dist/.
  external: ["vscode", "highlight.js"],
  logLevel: "info"
};

async function main() {
  console.log("copying vendor assets…");
  copyVendorAssets();

  if (vendorOnly) {
    return;
  }

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("watching…");
    return;
  }

  await esbuild.build(options);

  const bytes = fs.statSync(options.outfile).size;
  console.log(`bundled dist/extension.js — ${(bytes / 1024).toFixed(0)} KB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
