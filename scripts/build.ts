import { mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";

const outdir = resolve("dist");
const entrypoints = [resolve("src/background.ts"), resolve("src/content.ts"), resolve("src/content/page-bridge.ts")];

function copyStatic(): void {
  mkdirSync(outdir, { recursive: true });
  cpSync(resolve("public", "manifest.json"), resolve(outdir, "manifest.json"));
  cpSync(resolve("public", "icon-128.png"), resolve(outdir, "icon-128.png"));
}

copyStatic();

const firstBuild = await Bun.build({
  entrypoints,
  outdir,
  target: "browser",
  format: "esm",
  splitting: false,
  minify: false,
  sourcemap: "linked"
});

if (!firstBuild.success) {
  for (const log of firstBuild.logs) {
    console.error(log);
  }
  process.exit(1);
}
