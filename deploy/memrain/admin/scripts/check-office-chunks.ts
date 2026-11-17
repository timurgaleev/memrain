// Run after `vite build`: three.js must stay in the Office page's lazy chunks,
// model files must not inline data, and the 3D models must stay small.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Chunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const MANIFEST = join(DIST, ".vite", "manifest.json");
const MARKER = "WebGLRenderer";
const MODEL_DIR = "src/assets/office3d/";
const MODEL_BUDGET = 1.5 * 1024 * 1024;

function isOfficeModule(src: string | undefined): boolean {
  return src === "src/pages/Office.tsx" || (src?.startsWith("src/office/") ?? false);
}

function closure(manifest: Record<string, Chunk>, roots: string[], follow: (c: Chunk) => string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (seen.has(key) || !manifest[key]) continue;
    seen.add(key);
    queue.push(...follow(manifest[key]));
  }
  return seen;
}

// A .glb is a 12-byte header, then a JSON chunk (length, type, bytes).
function modelJson(name: string, bytes: Buffer): string {
  if (!name.endsWith(".glb")) return bytes.toString("utf8");
  return bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8");
}

if (!existsSync(MANIFEST)) {
  console.error(`No build manifest at ${MANIFEST}; run \`bun run build\` first.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, Chunk>;
const keys = Object.keys(manifest);
const problems: string[] = [];

const entryStatic = closure(manifest, keys.filter((k) => manifest[k]!.isEntry), (c) => c.imports ?? []);
const officeRoots = keys.filter((k) => manifest[k]!.isDynamicEntry && isOfficeModule(manifest[k]!.src));
const officeChunks = closure(manifest, officeRoots, (c) => [...(c.imports ?? []), ...(c.dynamicImports ?? [])]);
const allowed = new Set(
  [...officeChunks].filter((k) => !entryStatic.has(k)).map((k) => manifest[k]!.file),
);

const assetsDir = join(DIST, "assets");
const files = readdirSync(assetsDir);
for (const name of files.filter((f) => f.endsWith(".js"))) {
  const file = `assets/${name}`;
  if (readFileSync(join(assetsDir, name), "utf8").includes(MARKER) && !allowed.has(file)) {
    problems.push(`${file} carries three.js but is not an Office lazy chunk`);
  }
}

const modelSources = new Set(keys.filter((k) => k.startsWith(MODEL_DIR)).map((k) => k.slice(MODEL_DIR.length)));
for (const name of files.filter((f) => f.endsWith(".gltf") || f.endsWith(".glb"))) {
  const text = modelJson(name, readFileSync(join(assetsDir, name)));
  if (text.includes("data:")) problems.push(`assets/${name} inlines a data: URI`);
  const json = JSON.parse(text) as {
    buffers?: { uri?: string }[];
    images?: { uri?: string; bufferView?: number }[];
  };
  for (const image of json.images ?? []) {
    if (image.bufferView !== undefined) problems.push(`assets/${name} embeds an image (the CSP blocks blob: URLs)`);
  }
  for (const { uri } of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (uri !== undefined && !uri.startsWith("data:") && !modelSources.has(uri)) problems.push(`assets/${name} names ${uri}, which the build did not emit from ${MODEL_DIR}`);
  }
}

const modelFiles = new Set(keys.filter((k) => k.startsWith(MODEL_DIR)).map((k) => manifest[k]!.file));
const modelBytes = [...modelFiles].reduce((sum, file) => sum + statSync(join(DIST, file)).size, 0);
if (modelBytes > MODEL_BUDGET) problems.push(`3D models weigh ${modelBytes} bytes, over the ${MODEL_BUDGET} byte budget`);

if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
if (officeRoots.length === 0) console.log("no office chunk yet");
console.log(`ok: ${allowed.size} office lazy chunk(s); ${modelFiles.size} model files, ${modelBytes} bytes`);
