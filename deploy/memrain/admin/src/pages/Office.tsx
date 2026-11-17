import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { api } from "../api";
import type { FeedEvent, OfficeSnapshot } from "../admin-types.ts";
import { PageIntro } from "../components/PageIntro.tsx";
import { describeError } from "../hooks.ts";
import { emptyAmbient, planAmbient, targetFor, type AmbientState } from "../office/ambient.ts";
import { spreadLabels, type LabelBox } from "../office/labels.ts";
import { ROOMS, spotFor } from "../office/map.ts";
import {
  applyEvent,
  applySnapshot,
  eventKey,
  initialState,
  labelFor,
  lineFor,
  namesFromSnapshot,
  tick,
  variantFor,
  type Character,
  type OfficeState,
} from "../office/model.ts";
import { stepCharacter, type Pose } from "../office/motion.ts";
import type { OfficeScene, SceneCharacter } from "../office/scene3d.ts";
import { assignSeats, freeSeat, type Seat } from "../office/seats.ts";
import { facingToYaw, tileToWorld } from "../office/world.ts";

const POLL_MS = 30_000;
const FIRST_RETRY_MS = 5_000;
const TICK_MS = 250;
const PENDING_CAP = 50;
const PLAN_MS = 250;
// A press that moves further than this turns the view instead of picking a figure.
const DRAG_PX = 4;
// Room names float a little above the floor so furniture does not hide them.
const ROOM_LABEL_Y = 0.6;
// Idle name tags in a crowd stack upward this far at most, then step aside.
const MAX_LABEL_LIFT = 36;
// After a change the scene draws on its next frame; keep placing tags until it has.
const SETTLE_FRAMES = 2;
const NO_WEBGL = "Your browser cannot show the 3D office. The list shows the same activity.";

type Feed = "connecting" | "connected" | "disconnected";

interface Store {
  state: OfficeState | null;
  // When the first snapshot landed; clients that arrive later walk in from reception.
  loadedAt: number;
  // Set by the 3D view: wakes its frame loop when the state changes.
  wake: (() => void) | null;
}

function byLabel(a: Character, b: Character): number {
  return a.label.localeCompare(b.label);
}

function useOffice() {
  const store = useRef<Store>({ state: null, loadedAt: 0, wake: null });
  const [view, setView] = useState<OfficeState | null>(null);
  const [feed, setFeed] = useState<Feed>("connecting");
  const [error, setError] = useState("");

  const commit = useCallback((next: OfficeState) => {
    if (next === store.current.state) return;
    store.current.state = next;
    setView(next);
    store.current.wake?.();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let names = new Map<string, string>();
    let pending: FeedEvent[] = [];
    let inFlight = false;
    let again = false;
    let lastLoad = 0;
    let lastUnknownLoad = -Infinity;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryMs = FIRST_RETRY_MS;

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      clearTimeout(retry);
      const requestedAt = Date.now();
      lastLoad = requestedAt;
      try {
        const s = (await api.office(ctrl.signal)) as OfficeSnapshot;
        const now = Date.now();
        names = namesFromSnapshot(s);
        const st = store.current.state;
        if (st) {
          commit(applySnapshot(st, s, requestedAt, now));
        } else {
          store.current.loadedAt = now;
          commit(pending.reduce((acc, e) => applyEvent(acc, e, now, names), initialState(s, now)));
          pending = [];
        }
        setError("");
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setError(describeError(e));
          // Nothing to show yet: try again sooner than the poll, backing off up to it.
          if (!store.current.state) {
            retry = setTimeout(() => void load(), retryMs);
            retryMs = Math.min(retryMs * 2, POLL_MS);
          }
        }
      } finally {
        inFlight = false;
      }
      if (again && !ctrl.signal.aborted) {
        again = false;
        void load();
      }
    };

    void load();
    const poll = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    const ticker = setInterval(() => {
      const st = store.current.state;
      if (st && !document.hidden) commit(tick(st, Date.now()));
    }, TICK_MS);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastLoad >= POLL_MS) void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    // EventSource reconnects on its own; the badge just follows it.
    const es = new EventSource("/admin/events");
    es.onopen = () => setFeed("connected");
    es.onerror = () => setFeed(es.readyState === EventSource.CLOSED ? "disconnected" : "connecting");
    es.onmessage = (m) => {
      let e: FeedEvent;
      try {
        e = JSON.parse(m.data) as FeedEvent;
      } catch {
        return;
      }
      if (typeof e?.agent !== "string" || typeof e.operation !== "string") return;
      const st = store.current.state;
      if (!st) {
        if (pending.length < PENDING_CAP) pending.push(e);
        return;
      }
      const next = applyEvent(st, e, Date.now(), names);
      if (next === st) return;
      commit(next);
      // A new app or worker: fetch its proper name, but not on every call it makes.
      if (!names.has(eventKey(e)) && Date.now() - lastUnknownLoad >= POLL_MS) {
        lastUnknownLoad = Date.now();
        void load();
      }
    };

    return () => {
      ctrl.abort();
      clearTimeout(retry);
      es.close();
      clearInterval(poll);
      clearInterval(ticker);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [commit]);

  return { store, view, feed, error };
}

interface Overlay {
  labels: Map<string, HTMLDivElement>;
  rooms: (HTMLDivElement | null)[];
  tip: { id: string | null; el: HTMLDivElement | null };
  // Asks the frame loop to place the overlay again: a resize, a drag, a new tag or tooltip.
  poke: () => void;
}

interface Figures {
  poses: Map<string, Pose>;
  byId: Map<string, SceneCharacter>;
  chars: SceneCharacter[];
}

interface Size {
  w: number;
  h: number;
}

const ROOM_ANCHORS = ROOMS.map((r) => ({ id: r.id, label: r.label, ...tileToWorld({ x: r.x + (r.w - 1) / 2, y: r.y + (r.h - 1) / 2 }) }));

function sameCharacter(a: SceneCharacter, b: SceneCharacter): boolean {
  return a.label === b.label && a.worldX === b.worldX && a.worldZ === b.worldZ && a.yaw === b.yaw && a.pose === b.pose
    && a.moving === b.moving && a.busy === b.busy && a.error === b.error && a.enabled === b.enabled && a.variant === b.variant;
}

// Moves every figure one frame toward where it should be: its seat while it works,
// an idle activity in the break room, or its seat there otherwise. Updates figs in
// place and keeps each unchanged SceneCharacter, so a still office allocates nothing.
function advance(
  figs: Figures,
  st: OfficeState,
  seats: ReadonlyMap<string, Seat>,
  amb: AmbientState,
  dtMs: number,
  now: number,
  loadedAt: number,
  reducedMotion: boolean,
): { changed: boolean; moving: boolean; nextExpiry: number } {
  let changed = figs.byId.size !== st.characters.size;
  let moving = false;
  let nextExpiry = Infinity;
  for (const id of figs.byId.keys()) {
    if (st.characters.has(id)) continue;
    figs.byId.delete(id);
    figs.poses.delete(id);
    changed = true;
  }
  figs.chars.length = 0;
  for (const c of st.characters.values()) {
    const want = targetFor(c, amb, spotFor(c.room, seats.get(c.id)?.index ?? 0), now);
    let pose = figs.poses.get(c.id);
    if (!pose) {
      const walksIn = c.kind === "client" && c.arrivedAt > loadedAt;
      const from = walksIn ? spotFor("reception", freeSeat(seats, "reception")) : want.tile;
      pose = { x: from.x, y: from.y, path: [], facing: "down", frame: 0 };
    }
    pose = stepCharacter(pose, want.tile, dtMs, { reducedMotion });
    figs.poses.set(c.id, pose);
    const walking = pose.path.length > 0;
    const arrived = !walking && pose.x === want.tile.x && pose.y === want.tile.y;
    const at = tileToWorld(pose);
    const next: SceneCharacter = {
      id: c.id,
      label: c.label,
      worldX: at.x,
      worldZ: at.z,
      yaw: facingToYaw(arrived && want.facing ? want.facing : pose.facing),
      pose: want.pose,
      moving: walking,
      busy: c.busyUntil > now,
      error: c.errorUntil > now,
      enabled: c.enabled,
      variant: variantFor(c.id),
    };
    const prev = figs.byId.get(c.id);
    const keep = prev && sameCharacter(prev, next) ? prev : next;
    if (keep !== prev) {
      figs.byId.set(c.id, keep);
      changed = true;
    }
    figs.chars.push(keep);
    moving ||= walking;
    // busy and error flip on the clock alone, without a new state.
    for (const t of [c.busyUntil, c.errorUntil]) if (t > now && t < nextExpiry) nextExpiry = t;
  }
  return { changed, moving, nextExpiry };
}

function onCanvas(p: { x: number; y: number } | null, size: Size): p is { x: number; y: number } {
  return p !== null && p.x >= 0 && p.y >= 0 && p.x <= size.w && p.y <= size.h;
}

function place(el: HTMLElement, p: { x: number; y: number } | null, size: Size): void {
  const shown = onCanvas(p, size);
  el.style.visibility = shown ? "visible" : "hidden";
  if (!shown) return;
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
}

// Keeps names, badges and the tooltip over their figures without a React render per frame.
function placeOverlay(scene: OfficeScene, overlay: Overlay, st: OfficeState | null, now: number, size: Size): void {
  ROOM_ANCHORS.forEach((r, i) => {
    const el = overlay.rooms[i];
    if (el) place(el, scene.projectWorld(r.x, r.z, ROOM_LABEL_Y), size);
  });
  // Show or hide each badge before measuring, then move every tag, so the browser
  // lays out once per frame and a badge counts towards its tag's width.
  const boxes: (LabelBox & { el: HTMLDivElement })[] = [];
  for (const [id, el] of overlay.labels) {
    const c = st?.characters.get(id);
    el.classList.toggle("office-label-error", (c?.errorUntil ?? 0) > now);
    const p = scene.project(id);
    if (!onCanvas(p, size)) {
      el.style.visibility = "hidden";
      continue;
    }
    const w = el.offsetWidth;
    // Slide a tag sideways rather than let the stage edge cut it off.
    const x = Math.min(Math.max(p.x, w / 2), Math.max(w / 2, size.w - w / 2));
    boxes.push({ id, el, x, y: p.y, w, h: el.offsetHeight, keep: !!c && c.room !== "break_room" });
  }
  const spots = spreadLabels(boxes, MAX_LABEL_LIFT, size.w);
  for (const b of boxes) {
    const spot = spots.get(b.id);
    b.el.style.visibility = spot ? "visible" : "hidden";
    if (!spot) continue;
    b.el.style.left = `${spot.x}px`;
    b.el.style.top = `${b.y - spot.lift}px`;
  }
  const { id, el } = overlay.tip;
  if (id && el) place(el, scene.project(id), size);
}

// planAmbient keeps the same Activity object while an activity goes on.
function sameActivities(a: AmbientState, b: AmbientState): boolean {
  if (a.activities.size !== b.activities.size) return false;
  for (const [id, act] of b.activities) if (a.activities.get(id) !== act) return false;
  return true;
}

// The canvas is made here rather than by React: a scene owns its canvas for life
// and loses the WebGL context on dispose, so every scene gets a fresh one.
function useOfficeScene(
  hostRef: RefObject<HTMLDivElement | null>,
  boxRef: RefObject<HTMLDivElement | null>,
  store: RefObject<Store>,
  overlay: RefObject<Overlay>,
) {
  const sceneRef = useRef<OfficeScene | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const box = boxRef.current;
    if (failed || !host || !box) return;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "3D office with a figure for each app and background worker");
    host.append(canvas);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const size: Size = { w: box.clientWidth, h: box.clientHeight };
    let alive = true;
    let scene: OfficeScene | null = null;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    let sleep: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const figs: Figures = { poses: new Map(), byId: new Map(), chars: [] };
    let seats = new Map<string, Seat>();
    let seenState: OfficeState | null = null;
    let amb = emptyAmbient();
    let plannedAt = -Infinity;
    let moving = false;
    let nextExpiry = Infinity;
    let settle = SETTLE_FRAMES;

    function wake(): void {
      clearTimeout(sleep);
      if (raf || !alive || !scene || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    }
    // Only work when something can have changed: a new state or idle plan, a figure
    // walking, a busy or error flag running out, or the view moving.
    function frame(t: number): void {
      raf = 0;
      if (!alive || !scene || document.hidden) return;
      const dt = last ? t - last : 0;
      last = t;
      const st = store.current.state;
      const now = Date.now();
      let dirty = false;
      if (st) {
        let replan = st !== seenState;
        if (replan) {
          seats = assignSeats(seats, st.characters.values());
          seenState = st;
        }
        if (!reducedMotion && now - plannedAt >= PLAN_MS) {
          const next = planAmbient(st, amb, now, Math.random, { reducedMotion });
          plannedAt = now;
          replan ||= !sameActivities(amb, next);
          amb = next;
        }
        if (replan || moving || now >= nextExpiry) {
          const r = advance(figs, st, seats, amb, dt, now, store.current.loadedAt, reducedMotion);
          moving = r.moving;
          nextExpiry = r.nextExpiry;
          if (r.changed) {
            scene.update(figs.chars, now);
            dirty = true;
          }
        }
      }
      if (dirty) settle = SETTLE_FRAMES;
      const animating = scene.isAnimating();
      if (animating || settle > 0) placeOverlay(scene, overlay.current, st, now, size);
      settle = Math.max(0, settle - 1);
      if (animating || moving || settle > 0) {
        raf = requestAnimationFrame(frame);
        return;
      }
      // Asleep: a state change, resize, drag or tooltip wakes the loop; so do the
      // next idle plan and the next busy or error flag running out.
      const until = Math.min(reducedMotion ? Infinity : PLAN_MS, nextExpiry - now);
      if (Number.isFinite(until)) sleep = setTimeout(wake, Math.max(0, until) + 1);
    }
    const poke = () => {
      settle = SETTLE_FRAMES;
      wake();
    };
    store.current.wake = wake;
    overlay.current.poke = poke;
    const onVisible = () => {
      if (!document.hidden) poke();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const fail = () => {
      if (alive) setFailed(true);
    };

    import("../office/scene3d.ts")
      .then(({ createOfficeScene }) => (alive ? createOfficeScene(canvas, { reducedMotion }) : null))
      .then((s) => {
        if (!s) return;
        if (!alive) {
          s.dispose();
          return;
        }
        scene = s;
        sceneRef.current = s;
        s.onContextLost(fail);
        const resize = () => {
          size.w = box.clientWidth;
          size.h = box.clientHeight;
          s.resize(size.w, size.h, window.devicePixelRatio || 1);
          poke();
        };
        ro = new ResizeObserver(resize);
        ro.observe(box);
        resize();
      }, (e: unknown) => {
        console.warn("office: the 3D view could not start", e);
        fail();
      });
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(sleep);
      if (store.current.wake === wake) store.current.wake = null;
      overlay.current.poke = () => {};
      ro?.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      scene?.dispose();
      sceneRef.current = null;
      canvas.remove();
    };
  }, [hostRef, boxRef, store, overlay, failed]);

  return { sceneRef, failed };
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface PersonLine {
  id: string;
  text: string;
  off: boolean;
}

function sameLines(a: { lines: PersonLine[] }, b: { lines: PersonLine[] }): boolean {
  return a.lines.length === b.lines.length
    && a.lines.every((l, i) => l.id === b.lines[i]!.id && l.text === b.lines[i]!.text && l.off === b.lines[i]!.off);
}

// The only live region: it re-renders when a line's words change, not on every state tick.
const PeopleList = memo(function PeopleList({ lines }: { lines: PersonLine[] }) {
  return (
    <ul className="office-people" aria-live="polite">
      {lines.map((l) => (
        <li key={l.id} className={l.off ? "office-off" : undefined}>{l.text}</li>
      ))}
    </ul>
  );
}, sameLines);

function ActivityList({ view }: { view: OfficeState | null }) {
  if (!view) return <div className="feed-empty">Opening the office…</div>;
  const everyone = [...view.characters.values()];
  const clients = everyone.filter((c) => c.kind === "client").sort(byLabel);
  const workers = everyone.filter((c) => c.kind === "worker").sort(byLabel);
  const lines = [...clients, ...workers].map((c) => ({
    id: c.id,
    text: lineFor(c),
    off: c.kind === "worker" && !c.enabled,
  }));
  return (
    <>
      {clients.length === 0 && <p className="office-note">No apps have used this brain in the last day.</p>}
      <PeopleList lines={lines} />
      <h3 className="office-recent-title">Recent</h3>
      {view.recent.length === 0 ? (
        <p className="office-note">Nothing has happened since you opened this page.</p>
      ) : (
        <ol className="office-recent">
          {view.recent.slice(0, 20).map((r, i) => (
            <li key={`${r.at}-${i}`}>
              <time dateTime={new Date(r.at).toISOString()}>{formatTime(r.at)}</time>
              {r.text}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function FigureLabels({ view, overlay }: { view: OfficeState | null; overlay: RefObject<Overlay> }) {
  if (!view) return null;
  return (
    <>
      {[...view.characters.values()].map((c) => (
        <div
          key={c.id}
          className={`office-label${c.room !== "break_room" ? " office-label-busy" : ""}${c.enabled ? "" : " office-label-off"}`}
          ref={(el) => {
            if (el) overlay.current.labels.set(c.id, el);
            else overlay.current.labels.delete(c.id);
            overlay.current.poke();
          }}
        >
          {labelFor(c)}
          <span className="office-badge">!</span>
        </div>
      ))}
    </>
  );
}

export function OfficePage() {
  const { store, view, feed, error } = useOffice();
  const hostRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const overlay = useRef<Overlay>({ labels: new Map(), rooms: [], tip: { id: null, el: null }, poke: () => {} });
  const { sceneRef, failed } = useOfficeScene(hostRef, boxRef, store, overlay);
  const [tipId, setTipId] = useState<string | null>(null);
  const drag = useRef<{ pointer: number; startX: number; lastX: number; moved: boolean } | null>(null);
  useEffect(() => {
    overlay.current.tip.id = tipId;
    overlay.current.poke();
  }, [tipId]);

  const under = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return sceneRef.current?.pick(e.clientX - rect.left, e.clientY - rect.top) ?? null;
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sceneRef.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag.current = { pointer: e.pointerId, startX: e.clientX, lastX: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && d.pointer === e.pointerId) {
      if (!d.moved && Math.abs(e.clientX - d.startX) > DRAG_PX) {
        d.moved = true;
        d.lastX = d.startX;
      }
      if (d.moved) {
        sceneRef.current?.setOrbitDrag(e.clientX - d.lastX);
        overlay.current.poke();
        d.lastX = e.clientX;
      }
      return;
    }
    if (e.pointerType === "mouse") setTipId(under(e));
  };
  // A tap picks a figure; a second tap on the same one closes its tooltip.
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (d.moved) return;
    const id = under(e);
    setTipId((open) => (e.pointerType !== "mouse" && id !== null && open === id ? null : id));
  };
  const tipped = tipId ? view?.characters.get(tipId) : undefined;

  useEffect(() => {
    if (tipId && view && !view.characters.has(tipId)) setTipId(null);
  }, [tipId, view]);

  return (
    <>
      <h1 className="page-title">Office</h1>
      <PageIntro>
        A live view of who is working in this brain right now. Each figure is an app connected to it or one of its
        background workers; they walk to the room that matches what they are doing. Only the kind of work is shown,
        never what is in your brain.
      </PageIntro>
      <div className="office-status" role="status">
        <span className="strip-item">
          <span className={`dot ${feed === "connected" ? "dot-ok" : feed === "connecting" ? "dot-warn" : "dot-error"}`} />
          live feed {feed}
        </span>
      </div>
      {error && <div className="warning-bar">{error}</div>}

      <div className="office-layout">
        <div className="panel office-stage">
          {failed ? (
            <p className="office-note office-fallback">{NO_WEBGL}</p>
          ) : (
            <div
              className="office-canvas-box"
              ref={boxRef}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => { drag.current = null; }}
              onPointerLeave={(e) => { if (e.pointerType === "mouse" && !drag.current) setTipId(null); }}
            >
              <div className="office-gl" ref={hostRef} />
              <div className="office-overlay" aria-hidden="true">
                {ROOM_ANCHORS.map((r, i) => (
                  <div key={r.id} className="office-room" ref={(el) => { overlay.current.rooms[i] = el; }}>{r.label}</div>
                ))}
                <FigureLabels view={view} overlay={overlay} />
                {tipped && (
                  <div className="office-tip" ref={(el) => { overlay.current.tip.el = el; overlay.current.poke(); }}>
                    {lineFor(tipped)}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <section className="panel office-side">
          <h2 className="panel-title">Who is here</h2>
          <div className="office-list">
            <ActivityList view={view} />
          </div>
        </section>
      </div>
    </>
  );
}
