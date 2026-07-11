import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("exports a standalone Cloudflare Pages site", async () => {
  const html = await readFile(new URL("out/index.html", projectRoot), "utf8");

  assert.match(html, /<title>MassiveDyno UML Canvas/);
  assert.match(html, /箱を編集/);
  assert.match(html, /\/_next\/static\//);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /chatgpt\.site/);

  await access(new URL("out/plantuml/plantuml.js", projectRoot));
  await access(new URL("out/plantuml/plantuml-loader.js", projectRoot));
  await access(new URL("out/plantuml/viz-global.js", projectRoot));
  await access(new URL("out/_headers", projectRoot));
  await access(new URL("out/_redirects", projectRoot));
});
