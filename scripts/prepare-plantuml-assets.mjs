import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(projectRoot, "node_modules", "@plantuml", "core");
const outputRoot = resolve(projectRoot, "public", "plantuml");

function replaceExactlyOnce(source, from, to) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one occurrence of ${from}, found ${occurrences}`);
  }
  return source.replace(from, to);
}

await mkdir(outputRoot, { recursive: true });

for (const filename of ["emoji.js", "openiconic.js", "viz-global.js", "LICENSE"]) {
  await copyFile(resolve(packageRoot, filename), resolve(outputRoot, filename));
}

let plantUml = await readFile(resolve(packageRoot, "plantuml.js"), "utf8");
plantUml = replaceExactlyOnce(
  plantUml,
  "p>4096.0",
  "p>(globalThis.__PLANTUML_VIEWER_LIMIT__||8192.0)",
);
plantUml = replaceExactlyOnce(
  plantUml,
  "q>4096.0",
  "q>(globalThis.__PLANTUML_VIEWER_LIMIT__||8192.0)",
);
plantUml = replaceExactlyOnce(plantUml, "(max 4096)", "(max 8192)");

await writeFile(resolve(outputRoot, "plantuml.js"), plantUml);
console.log("Prepared @plantuml/core browser assets with the viewer limit patch.");
