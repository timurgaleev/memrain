// The 3D office: an isometric diorama of the rooms in map.ts with the people on top.
// Each createOfficeScene call needs its own <canvas>: dispose() forces the WebGL
// context lost, so a canvas is never handed to a second scene.
import {
  AnimationClip,
  AnimationMixer,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  LoadingManager,
  LoopPingPong,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  OrthographicCamera,
  PCFShadowMap,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type Object3D,
} from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneRig } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CHARACTER_VARIANTS, MODEL_URLS, resolveModelFile } from "./assets3d.ts";
import { OFFICE_MAP, PROPS, WALL_DECOR } from "./map.ts";
import type { targetFor } from "./ambient.ts";
import { buildPlacements, buildSeats, floorBoxes, SPEC, tileKey, WALL_H, WALL_T, wallBoxes, type BoxItem, type Furniture, type Placement, type Seat } from "./layout3d.ts";
import { animPose, clipFor, syncCharacters, type ClipName } from "./anim.ts";
import { WORLD_TILE } from "./world.ts";
import type { Tile } from "./path.ts";

type PoseKind = ReturnType<typeof targetFor>["pose"];

export interface SceneCharacter {
  id: string;
  label: string;
  worldX: number;
  worldZ: number;
  yaw: number;
  pose: PoseKind;
  moving: boolean;
  busy: boolean;
  error: boolean;
  enabled: boolean;
  variant: number;
}

export interface OfficeScene {
  update(chars: readonly SceneCharacter[], now: number): void;
  resize(cssW: number, cssH: number, dpr: number): void;
  pick(cssX: number, cssY: number): string | null;
  // Screen position (CSS px) above a character's head, for labels and badges.
  project(id: string): { x: number; y: number } | null;
  // Screen position (CSS px) of a world point, for room labels; y is the height.
  projectWorld(x: number, z: number, y?: number): { x: number; y: number } | null;
  // Horizontal drag in CSS px since the last call; the view turns at most 30° either way.
  setOrbitDrag(dx: number): void;
  dispose(): void;
  onContextLost(cb: () => void): void;
}

const W = OFFICE_MAP.width;
const H = OFFICE_MAP.height;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const FLOOR_H = 0.08;
const CHARACTER_SCALE = 1.6;
const HEAD_Y = 1.2;
// The sit clip drops the hips to the floor; a seat lifts them back up by its height.
const SIT_HIP = 0.04;

const BASE_AZIMUTH = 45 * DEG;
const ELEVATION = 36 * DEG;
const AUTO_ORBIT = 15 * DEG;
const AUTO_PERIOD_S = 48;
const DRAG_LIMIT = 30 * DEG;
const DRAG_RAD_PER_PX = 0.006;
const IDLE_FPS = 30;
const FADE_S = 0.3;

const SLAB_COLOR = "#2b3040";
const GLOW_BUSY = "#3ee6b5";
const GLOW_ERROR = "#ff5d5d";

const FALLBACK_SIZE = { x: 0.5, y: 0.5, z: 0.5 };
const LIVE = new WeakSet<HTMLCanvasElement>();

interface Template {
  root: Object3D;
  size: Vector3;
  fix: Matrix4;
}

// Radial alpha falloff, uploaded straight to the GPU; no image URL involved.
function radialTexture(profile: (r: number) => number): DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) / (n / 2);
      const o = (j * n + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(255 * Math.max(0, Math.min(1, profile(r))));
    }
  }
  const t = new DataTexture(data, n, n);
  t.needsUpdate = true;
  return t;
}

function templateOf(root: Object3D): Template {
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  const c = box.getCenter(new Vector3());
  return { root, size, fix: new Matrix4().makeTranslation(-c.x, -box.min.y, -c.z) };
}

function instance(t: Template, ps: readonly Placement[]): InstancedMesh[] {
  const meshes: InstancedMesh[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  t.root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const im = new InstancedMesh(o.geometry as BufferGeometry, o.material as Material, ps.length);
    ps.forEach((p, i) => {
      m.compose(new Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.yaw), new Vector3(p.sx, SPEC[p.kind].scale, p.sz));
      im.setMatrixAt(i, m.multiply(t.fix).multiply(o.matrixWorld));
      if (p.tint) im.setColorAt(i, new Color(p.tint));
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    meshes.push(im);
  });
  return meshes;
}

function boxInstances(items: readonly BoxItem[], geo: BoxGeometry, mat: MeshStandardMaterial, height: number): InstancedMesh {
  const im = new InstancedMesh(geo, mat, items.length);
  const m = new Matrix4();
  const q = new Quaternion();
  items.forEach((b, i) => {
    im.setMatrixAt(i, m.compose(new Vector3(b.x, 0, b.z), q, new Vector3(b.sx, height, b.sz)));
    im.setColorAt(i, new Color(b.color).multiplyScalar(b.shade));
  });
  im.receiveShadow = true;
  return im;
}

function ghostOf(base: MeshStandardMaterial): MeshStandardMaterial {
  const g = base.clone();
  g.transparent = true;
  g.opacity = 0.55;
  g.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      "#include <map_fragment>\n\tdiffuseColor.rgb = vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)));",
    );
  };
  g.customProgramCacheKey = () => "office-ghost";
  return g;
}

interface Figure {
  state: SceneCharacter;
  root: Group;
  mixer: AnimationMixer;
  sets: Map<string, AnimationAction[]>;
  clip: string;
  torso: Object3D | undefined;
  torsoRest: Quaternion;
  meshes: Mesh[];
  normal: Material[];
  ghost: Material[];
  isGhost: boolean;
  ring: Mesh;
  hit: Mesh;
  yaw: number;
  off: Vector3;
  since: number;
  phase: number;
  placed: boolean;
}

function hashPhase(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 1000;
}

function shortestTurn(from: number, to: number): number {
  return ((((to - from) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
}

export async function createOfficeScene(canvas: HTMLCanvasElement, opts: { reducedMotion: boolean }): Promise<OfficeScene> {
  const reduced = opts.reducedMotion;
  if (LIVE.has(canvas)) throw new Error("This canvas already hosts an office scene; give each scene its own canvas.");
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setClearColor(0x000000, 0);

  const manager = new LoadingManager();
  manager.setURLModifier(resolveModelFile);
  const loader = new GLTFLoader(manager);

  const { seats, sofaSpots, chairs } = buildSeats();
  const kinds = new Set<Furniture>(["chair", "monitor", "counter", "rug"]);
  for (const p of [...PROPS, ...WALL_DECOR]) if (p.kind && p.kind !== "character") kinds.add(p.kind);
  LIVE.add(canvas);
  // A missing piece of furniture leaves a gap; missing people mean no office at all.
  const kindList = [...kinds];
  const [settled, people] = await Promise.all([
    Promise.allSettled(kindList.map(async (k) => [k, (await loader.loadAsync(MODEL_URLS[k])).scene] as const)),
    Promise.all(CHARACTER_VARIANTS.map((url) => loader.loadAsync(url))),
  ]).catch((e: unknown) => {
    LIVE.delete(canvas);
    renderer.dispose();
    renderer.forceContextLoss();
    throw e;
  });
  const furniture = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const missing = kindList.filter((_, i) => settled[i]?.status === "rejected");
  if (missing.length) console.warn(`office: left out models that did not load: ${missing.join(", ")}`);

  const templates = new Map<Furniture, Template>();
  for (const [k, root] of furniture) {
    if (k === "whiteboard") {
      root.traverse((o) => {
        if (o instanceof Mesh && o.material instanceof MeshStandardMaterial && o.material.name === "glass") {
          o.material.color.set("#fbfcfd");
          o.material.emissive.set("#ffffff");
          o.material.emissiveIntensity = 0.12;
        }
      });
    }
    if (k === "rug") {
      // Rugs take their colour per instance; the darker border keeps its shade.
      root.traverse((o) => {
        if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) {
          o.material.color.set(o.material.name === "carpetDarker" ? "#c9c9c9" : "#ffffff");
        }
      });
    }
    templates.set(k, templateOf(root));
  }

  const scene = new Scene();
  const owned = { geometries: new Set<BufferGeometry>(), materials: new Set<Material>(), textures: new Set<Texture>() };
  const own = <T extends BufferGeometry | Material | Texture>(x: T): T => {
    if (x instanceof BufferGeometry) owned.geometries.add(x);
    else if (x instanceof Material) owned.materials.add(x);
    else owned.textures.add(x);
    return x;
  };

  // Lights: a cool sky fill and one warm key light that owns the shadows.
  scene.add(new HemisphereLight("#e6eeff", "#5a4c3e", 1.6));
  const sun = new DirectionalLight("#fff1dc", 2.4);
  sun.position.set(-9, 20, 11);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 18, bottom: -18, near: 1, far: 60 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);

  // Floor with a faint checker per zone, thin low walls, a slab underneath.
  const floorGeo = own(new BoxGeometry(WORLD_TILE, 1, WORLD_TILE).translate(0, -0.5, 0));
  const floorMat = own(new MeshStandardMaterial({ roughness: 0.9 }));
  scene.add(boxInstances(floorBoxes(), floorGeo, floorMat, FLOOR_H));
  const wallGeo = own(new BoxGeometry(WORLD_TILE, 1, WORLD_TILE).translate(0, 0.5 - FLOOR_H / (WALL_H + FLOOR_H), 0));
  const wallMat = own(new MeshStandardMaterial({ roughness: 0.85 }));
  const walls = boxInstances(wallBoxes(), wallGeo, wallMat, WALL_H + FLOOR_H);
  walls.castShadow = true;
  scene.add(walls);
  const slab = new Mesh(
    own(new BoxGeometry(W - 1 + WALL_T, 0.36, H - 1 + WALL_T).translate(0, -FLOOR_H - 0.18, 0)),
    own(new MeshStandardMaterial({ color: SLAB_COLOR, roughness: 0.8 })),
  );
  scene.add(slab);
  const halo = new Mesh(
    own(new PlaneGeometry(W * 1.35, H * 1.45).rotateX(-Math.PI / 2)),
    own(new MeshBasicMaterial({
      color: "#000000",
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      map: own(radialTexture((r) => (1 - r) ** 1.6)),
    })),
  );
  halo.position.y = -FLOOR_H - 0.37;
  scene.add(halo);

  // Furniture, one instanced mesh per model part.
  const placements = buildPlacements((k) => templates.get(k)?.size ?? FALLBACK_SIZE, chairs);
  for (const [k, t] of templates) {
    const ps = placements.filter((p) => p.kind === k);
    if (!ps.length) continue;
    const parts = instance(t, ps);
    if (k === "rug") for (const im of parts) im.castShadow = false;
    scene.add(...parts);
  }

  // Characters share each variant's geometry and clips; clones only own their rig.
  const glowTex = own(radialTexture((r) => (r > 1 ? 0 : 0.9 * Math.exp(-(((r - 0.62) / 0.17) ** 2)) + 0.28 * Math.max(0, 1 - r / 0.62))));
  const glowGeo = own(new PlaneGeometry(1.25, 1.25).rotateX(-Math.PI / 2));
  const busyMat = own(new MeshBasicMaterial({ color: GLOW_BUSY, map: glowTex, transparent: true, depthWrite: false }));
  const errorMat = own(new MeshBasicMaterial({ color: GLOW_ERROR, map: glowTex, transparent: true, depthWrite: false }));
  const hitGeo = own(new BoxGeometry(0.62, HEAD_Y, 0.62).translate(0, HEAD_Y / 2, 0));
  const hitMat = own(new MeshBasicMaterial({ visible: false }));
  const ghosts = new Map<Material, Material>();
  const ghostFor = (m: Material) => {
    let g = ghosts.get(m);
    if (!g) {
      g = m instanceof MeshStandardMaterial ? own(ghostOf(m)) : m;
      ghosts.set(m, g);
    }
    return g;
  };
  const sitLower = new Map<GLTF, AnimationClip>();
  for (const g of people) {
    const sit = g.animations.find((a) => a.name === "sit");
    if (sit) sitLower.set(g, new AnimationClip("sit-lower", -1, sit.tracks.filter((t) => /^(?:root|leg-)/.test(t.name))));
  }

  const figures = new Map<string, Figure>();

  function makeFigure(c: SceneCharacter): Figure {
    const gltf = people[((c.variant % people.length) + people.length) % people.length]!;
    const model = cloneRig(gltf.scene);
    model.scale.setScalar(CHARACTER_SCALE);
    const meshes: Mesh[] = [];
    model.traverse((o) => {
      if (o instanceof Mesh) {
        o.castShadow = true;
        o.frustumCulled = false;
        meshes.push(o);
      }
    });
    const root = new Group();
    root.add(model);
    // The ring lies on the floor under the figure's tile, even while it sits up on a seat.
    const ring = new Mesh(glowGeo, busyMat);
    ring.renderOrder = 1;
    ring.visible = false;
    const hit = new Mesh(hitGeo, hitMat);
    hit.userData.id = c.id;
    root.add(hit);
    scene.add(root, ring);

    const mixer = new AnimationMixer(model);
    const phase = hashPhase(c.id);
    const action = (name: string) => {
      const clip = name === "sit-lower" ? sitLower.get(gltf) : gltf.animations.find((a) => a.name === name);
      if (!clip) return [];
      const a = mixer.clipAction(clip);
      a.time = phase % clip.duration;
      if (name === "walk") a.timeScale = 1.35;
      if (name === "pick-up") {
        a.setLoop(LoopPingPong, Infinity);
        a.timeScale = 0.35;
      }
      if (name === "interact-right") a.timeScale = 0.8;
      return [a];
    };
    const sets = new Map<string, AnimationAction[]>();
    for (const name of ["idle", "walk", "sit", "interact-right", "pick-up", "emote-yes"]) sets.set(name, action(name));
    // Typing at a desk: legs from the sit clip, upper body from the interact clip.
    sets.set("type", [...action("sit-lower"), ...sets.get("interact-right")!]);
    const torso = model.getObjectByName("torso");
    return {
      state: c,
      root,
      mixer,
      sets,
      clip: "",
      torso,
      torsoRest: torso ? torso.quaternion.clone() : new Quaternion(),
      meshes,
      normal: meshes.map((m) => m.material as Material),
      ghost: meshes.map((m) => ghostFor(m.material as Material)),
      isGhost: false,
      ring,
      hit,
      yaw: c.yaw,
      off: new Vector3(),
      since: 0,
      phase,
      placed: false,
    };
  }

  function dropFigure(f: Figure): void {
    // Each clone owns its skeleton's bone texture; geometry and materials stay shared.
    f.root.traverse((o) => {
      if (o instanceof SkinnedMesh) o.skeleton.dispose();
    });
    f.mixer.stopAllAction();
    f.mixer.uncacheRoot(f.mixer.getRoot());
    scene.remove(f.root, f.ring);
  }

  function tileOf(c: SceneCharacter): Tile {
    return { x: Math.round(c.worldX / WORLD_TILE + W / 2 - 0.5), y: Math.round(c.worldZ / WORLD_TILE + H / 2 - 0.5) };
  }

  function seatOf(c: SceneCharacter): Seat | undefined {
    if (c.moving) return undefined;
    const t = tileOf(c);
    if (c.pose === "sofa") return sofaSpots.get(tileKey(t.x, t.y));
    if (c.pose === "sit" || c.pose === "idle" || c.pose === "work") return seats.get(tileKey(t.x, t.y));
    return undefined;
  }

  function play(f: Figure, name: ClipName, fade: number): void {
    if (f.clip === name) return;
    const prev = f.sets.get(f.clip) ?? [];
    // A model without the clip plays idle instead; every shipped person has all of them.
    const next = f.sets.get(name)?.length ? f.sets.get(name)! : (f.sets.get("idle") ?? []);
    for (const a of prev) {
      if (next.includes(a)) continue;
      if (fade > 0) a.fadeOut(fade);
      else a.stop();
    }
    for (const a of next) {
      if (prev.includes(a)) continue;
      a.reset();
      a.time = f.phase % a.getClip().duration;
      if (fade > 0) a.fadeIn(fade);
      a.play();
    }
    f.clip = name;
  }

  function setGhost(f: Figure, ghost: boolean): void {
    if (f.isGhost === ghost) return;
    f.meshes.forEach((m, i) => {
      m.material = ghost ? f.ghost[i]! : f.normal[i]!;
      m.castShadow = !ghost;
    });
    f.isGhost = ghost;
  }

  // Camera: orthographic, isometric, framed once per resize for the widest orbit angle.
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const target = new Vector3(0, 0.2, 0);
  let cssW = 1;
  let cssH = 1;
  let autoAngle = 0;
  let dragAngle = 0;
  let dragAt = -Infinity;

  function aim(azimuth: number): void {
    const d = 60;
    camera.position.set(
      target.x + Math.sin(azimuth) * Math.cos(ELEVATION) * d,
      target.y + Math.sin(ELEVATION) * d,
      target.z + Math.cos(azimuth) * Math.cos(ELEVATION) * d,
    );
    camera.lookAt(target);
    camera.updateMatrixWorld();
  }

  function fitCamera(): void {
    // Projected size peaks at 45°, so a fit there holds for every orbit angle.
    aim(BASE_AZIMUTH);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const p = new Vector3();
    const ex = (W - 1 + WALL_T) / 2;
    const ez = (H - 1 + WALL_T) / 2;
    for (const x of [-ex, ex]) for (const z of [-ez, ez]) for (const y of [-0.45, 1.3]) {
      p.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const margin = 1.03;
    let halfW = ((maxX - minX) / 2) * margin;
    let halfH = ((maxY - minY) / 2) * margin;
    const aspect = cssW / cssH;
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;
    const cy = (maxY + minY) / 2;
    const cx = (maxX + minX) / 2;
    Object.assign(camera, { left: cx - halfW, right: cx + halfW, top: cy + halfH, bottom: cy - halfH });
    camera.updateProjectionMatrix();
  }

  // Rendering is on demand. With motion allowed the loop runs while the canvas is on
  // screen: full frame rate while someone walks, works or the view is dragged, 30 fps
  // otherwise. With reduced motion nothing animates and a frame is drawn per change.
  let raf = 0;
  let last = 0;
  let clock = 0;
  let needsRender = true;
  let disposed = false;
  let lost = false;
  let onScreen = true;
  let pageVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
  let lastNow = 0;
  let lastNowAt = performance.now();
  let lostCb: (() => void) | null = null;

  const running = () => !disposed && !lost && onScreen && pageVisible;
  const schedule = () => {
    if (!raf && running()) raf = requestAnimationFrame(tick);
  };

  function busyOrMoving(): boolean {
    for (const f of figures.values()) if (f.state.moving || f.state.busy) return true;
    return performance.now() - dragAt < 600;
  }

  const scratch = new Vector3();

  function step(dt: number): void {
    clock += dt;
    if (!reduced) autoAngle = AUTO_ORBIT * Math.sin((TAU * clock) / AUTO_PERIOD_S);
    aim(BASE_AZIMUTH + autoAngle + dragAngle);
    const pulse = reduced ? 0.85 : 0.7 + 0.25 * Math.sin(clock * 3.2);
    busyMat.opacity = pulse;
    errorMat.opacity = reduced ? 0.9 : 0.75 + 0.25 * Math.sin(clock * 7);

    const now = lastNow + (performance.now() - lastNowAt);
    const k = reduced ? 1 : 1 - Math.exp(-dt * 10);
    for (const f of figures.values()) {
      const c = f.state;
      const seat = seatOf(c);
      play(f, clipFor(c.pose, c.moving, seat !== undefined, now - f.since, f.phase), reduced || !f.placed ? 0 : FADE_S);
      setGhost(f, !c.enabled);
      f.ring.visible = c.enabled && (c.busy || c.error);
      f.ring.material = c.error ? errorMat : busyMat;
      f.ring.position.set(c.worldX, 0.012, c.worldZ);

      const wantYaw = seat ? seat.yaw : c.yaw;
      const wantOff = seat ? scratch.set(seat.x - c.worldX, seat.height - SIT_HIP, seat.z - c.worldZ) : scratch.set(0, 0, 0);
      const snap = !f.placed || reduced;
      f.yaw = snap ? wantYaw : f.yaw + shortestTurn(f.yaw, wantYaw) * Math.min(1, dt * 12);
      f.off.lerp(wantOff, snap ? 1 : k);
      f.placed = true;

      const body = animPose(c.moving ? "walk" : c.pose, clock + f.phase);
      const bob = !c.moving && !seat && !reduced ? body.bob : 0;
      f.root.position.set(c.worldX + f.off.x, f.off.y + bob, c.worldZ + f.off.z);
      f.root.rotation.y = f.yaw;

      if (f.torso) f.torso.quaternion.copy(f.torsoRest);
      f.mixer.update(reduced ? 0 : dt);
      if (f.torso && !c.moving && !seat && !reduced && (c.pose === "water_plants" || c.pose === "whiteboard" || c.pose === "chat")) {
        f.torso.rotateX(body.lean);
      }
    }
  }

  function tick(t: number): void {
    raf = 0;
    if (!running()) return;
    if (!reduced && !needsRender && last && !busyOrMoving() && t - last < 1000 / IDLE_FPS - 2) {
      schedule();
      return;
    }
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    step(dt);
    renderer.render(scene, camera);
    needsRender = false;
    if (!reduced) schedule();
  }

  const onVisibility = () => {
    pageVisible = document.visibilityState !== "hidden";
    last = 0;
    if (pageVisible) {
      needsRender = true;
      schedule();
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    last = 0;
    if (onScreen) {
      needsRender = true;
      schedule();
    }
  });
  observer?.observe(canvas);
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lostCb?.();
  };
  canvas.addEventListener("webglcontextlost", onLost);

  const raycaster = new Raycaster();
  const toNdc = (x: number, y: number) => new Vector2((x / cssW) * 2 - 1, -(y / cssH) * 2 + 1);
  const toCss = (v: Vector3) => {
    v.project(camera);
    if (Math.abs(v.z) > 1) return null;
    return { x: ((v.x + 1) / 2) * cssW, y: ((1 - v.y) / 2) * cssH };
  };

  const sameState = (a: SceneCharacter, b: SceneCharacter) =>
    a.worldX === b.worldX && a.worldZ === b.worldZ && a.yaw === b.yaw && a.pose === b.pose && a.moving === b.moving
    && a.busy === b.busy && a.error === b.error && a.enabled === b.enabled && a.variant === b.variant;

  fitCamera();

  return {
    update(chars, now) {
      if (disposed) return;
      lastNow = now;
      lastNowAt = performance.now();
      const wanted = new Map(chars.map((c) => [c.id, c]));
      const { add, remove } = syncCharacters(new Set(figures.keys()), new Set(wanted.keys()));
      let changed = add.length > 0 || remove.length > 0;
      for (const id of remove) {
        dropFigure(figures.get(id)!);
        figures.delete(id);
      }
      for (const [id, c] of wanted) {
        let f = figures.get(id);
        if (f && f.state.variant !== c.variant) {
          dropFigure(f);
          figures.delete(id);
          f = undefined;
        }
        if (!f) {
          f = makeFigure(c);
          f.since = now;
          figures.set(id, f);
          changed = true;
          continue;
        }
        if (f.state.pose !== c.pose || f.state.moving !== c.moving) f.since = now;
        if (!sameState(f.state, c)) changed = true;
        f.state = c;
      }
      if (changed) {
        needsRender = true;
        schedule();
      }
    },
    resize(w, h, dpr) {
      if (disposed) return;
      cssW = Math.max(1, w);
      cssH = Math.max(1, h);
      renderer.setPixelRatio(Math.min(2, Math.max(1, dpr)));
      renderer.setSize(cssW, cssH, false);
      fitCamera();
      aim(BASE_AZIMUTH + autoAngle + dragAngle);
      needsRender = true;
      schedule();
    },
    pick(x, y) {
      if (disposed) return null;
      raycaster.setFromCamera(toNdc(x, y), camera);
      const hits = raycaster.intersectObjects([...figures.values()].map((f) => f.hit), false);
      return (hits[0]?.object.userData.id as string | undefined) ?? null;
    },
    project(id) {
      const f = figures.get(id);
      if (!f || disposed) return null;
      return toCss(new Vector3(f.root.position.x, f.root.position.y + HEAD_Y, f.root.position.z));
    },
    projectWorld(x, z, y = 0) {
      return disposed ? null : toCss(new Vector3(x, y, z));
    },
    setOrbitDrag(dx) {
      if (disposed || !Number.isFinite(dx)) return;
      dragAngle = Math.max(-DRAG_LIMIT, Math.min(DRAG_LIMIT, dragAngle + dx * DRAG_RAD_PER_PX));
      dragAt = performance.now();
      if (reduced) aim(BASE_AZIMUTH + dragAngle);
      needsRender = true;
      schedule();
    },
    onContextLost(cb) {
      lostCb = cb;
      if (lost) cb();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      for (const f of figures.values()) dropFigure(f);
      figures.clear();
      const roots: Object3D[] = [scene, ...furniture.map(([, r]) => r), ...people.map((g) => g.scene)];
      for (const r of roots) {
        r.traverse((o) => {
          if (!(o instanceof Mesh)) return;
          own(o.geometry as BufferGeometry);
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) own(m as Material);
          if (o instanceof InstancedMesh) o.dispose();
        });
      }
      for (const m of owned.materials) {
        for (const v of Object.values(m)) if (v instanceof Texture) owned.textures.add(v);
        m.dispose();
      }
      for (const g of owned.geometries) g.dispose();
      for (const t of owned.textures) t.dispose();
      sun.dispose();
      renderer.dispose();
      if (!lost) renderer.forceContextLoss();
      LIVE.delete(canvas);
    },
  };
}
