// Run after `vite build`: three.js must stay out of the admin entry's static
// imports, model files must not inline data, and the 3D models must stay small.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ManifestChunk {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

export type Manifest = Record<string, ManifestChunk>;

const MODEL_DIR = "src/assets/office3d/";
const MODEL_BUDGET = 1_500_000;

// Everything the page loads before any dynamic import() runs.
export function staticClosure(manifest: Manifest, entryKey: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entryKey];
  while (queue.length > 0) {
    const key = queue.pop()!;
    const chunk = manifest[key];
    if (seen.has(key) || !chunk) continue;
    seen.add(key);
    queue.push(...(chunk.imports ?? []));
  }
  return seen;
}

function isThree(key: string, chunk: ManifestChunk): boolean {
  return chunk.name === "three" || `${key} ${chunk.src ?? ""}`.includes("node_modules/three/");
}

export function threeInStaticClosure(manifest: Manifest, entryKey: string): boolean {
  return [...staticClosure(manifest, entryKey)].some((key) => isThree(key, manifest[key]!));
}

export function modelsOverBudget(bytes: number): boolean {
  return bytes > MODEL_BUDGET;
}

// A .glb is a 12-byte header, then a JSON chunk (length, type, bytes).
function modelJson(name: string, bytes: Buffer): string {
  if (!name.endsWith(".glb")) return bytes.toString("utf8");
  return bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8");
}

function main(): void {
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  const manifestPath = join(dist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`No build manifest at ${manifestPath}; run \`bun run build\` first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const keys = Object.keys(manifest);
  const problems: string[] = [];

  for (const entry of keys.filter((k) => manifest[k]!.isEntry)) {
    if (threeInStaticClosure(manifest, entry)) problems.push(`${manifest[entry]!.file} imports three.js statically`);
  }

  const assetsDir = join(dist, "assets");
  const modelSources = new Set(keys.filter((k) => k.startsWith(MODEL_DIR)).map((k) => k.slice(MODEL_DIR.length)));
  for (const name of readdirSync(assetsDir).filter((f) => f.endsWith(".gltf") || f.endsWith(".glb"))) {
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
  const modelBytes = [...modelFiles].reduce((sum, file) => sum + statSync(join(dist, file)).size, 0);
  if (modelsOverBudget(modelBytes)) problems.push(`3D models weigh ${modelBytes} bytes, over the ${MODEL_BUDGET} byte budget`);

  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  const threeChunks = keys.filter((k) => isThree(k, manifest[k]!));
  if (threeChunks.length === 0) console.log("no office chunk yet");
  console.log(`ok: three.js in ${threeChunks.length} lazy chunk(s); ${modelFiles.size} model files, ${modelBytes} bytes`);
}

if (import.meta.main) main();
