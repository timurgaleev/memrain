import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { api } from "../api";
import type { FeedEvent, OfficeSnapshot } from "../admin-types.ts";
import { PageIntro } from "../components/PageIntro.tsx";
import { describeError } from "../hooks.ts";
import { OFFICE_MAP, TILE, officeLayout, seatFor } from "../office/map.ts";
import {
  applyEvent,
  applySnapshot,
  describe,
  initialState,
  namesFromSnapshot,
  tick,
  type Character,
  type OfficeState,
} from "../office/model.ts";
import { stepCharacter, type Pose } from "../office/motion.ts";
import { drawOffice } from "../office/render.ts";
import { assignSeats, freeSeat, type Seat } from "../office/seats.ts";
import { loadSprites, type Sprites } from "../office/sprites.ts";

const POLL_MS = 30_000;
const FIRST_RETRY_MS = 5_000;
const TICK_MS = 250;
const PENDING_CAP = 50;
const MAP_W = OFFICE_MAP.width * TILE;
const MAP_H = OFFICE_MAP.height * TILE;
// Below this share of the column a crisp whole-number scale looks lost, so the canvas fills the column instead.
const MIN_CRISP_FILL = 0.75;

type Feed = "connecting" | "connected" | "disconnected";

interface Store {
  state: OfficeState | null;
  // When the first snapshot landed; clients that arrive later walk in from reception.
  loadedAt: number;
}

interface Point {
  left: number;
  top: number;
}

function lineFor(c: Character): string {
  return c.kind === "worker" && !c.enabled ? `${c.label} is off` : describe(c);
}

function byLabel(a: Character, b: Character): number {
  return a.label.localeCompare(b.label);
}

function useOffice() {
  const store = useRef<Store>({ state: null, loadedAt: 0 });
  const [view, setView] = useState<OfficeState | null>(null);
  const [feed, setFeed] = useState<Feed>("connecting");
  const [error, setError] = useState("");

  const commit = useCallback((next: OfficeState) => {
    if (next === store.current.state) return;
    store.current.state = next;
    setView(next);
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
      if (!names.has(e.agent) && Date.now() - lastUnknownLoad >= POLL_MS) {
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

function advancePoses(
  prev: Map<string, Pose>,
  st: OfficeState,
  seats: ReadonlyMap<string, Seat>,
  dtMs: number,
  loadedAt: number,
  reducedMotion: boolean,
): Map<string, Pose> {
  const next = new Map<string, Pose>();
  for (const c of st.characters.values()) {
    const target = seatFor(c.room, seats.get(c.id)?.index ?? 0);
    let pose = prev.get(c.id);
    if (!pose) {
      const walksIn = c.kind === "client" && c.arrivedAt > loadedAt;
      const from = walksIn ? seatFor("reception", freeSeat(seats, "reception")) : target;
      pose = { x: from.x, y: from.y, path: [], facing: "down", frame: 0 };
    }
    next.set(c.id, stepCharacter(pose, target, dtMs, { reducedMotion }));
  }
  return next;
}

// Backing store in device pixels at a whole-number scale when that still fills
// most of the column; otherwise fill the column and let the browser resample.
function fitCanvas(canvas: HTMLCanvasElement, available: number): void {
  if (available <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const whole = Math.floor((available * dpr) / MAP_W);
  const crisp = whole >= 1 && (whole * MAP_W) / dpr >= available * MIN_CRISP_FILL;
  const scale = crisp ? whole : whole >= 1 ? whole + 1 : 0;
  const w = scale > 0 ? scale * MAP_W : Math.max(1, Math.round(available * dpr));
  const h = scale > 0 ? scale * MAP_H : Math.max(1, Math.round((w * MAP_H) / MAP_W));
  const cssW = crisp ? w / dpr : available;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${(cssW * MAP_H) / MAP_W}px`;
}

function useOfficeCanvas(
  fitRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  store: RefObject<Store>,
  tip: RefObject<{ id: string | null; el: HTMLDivElement | null }>,
) {
  const poses = useRef(new Map<string, Pose>());
  const [spritesFailed, setSpritesFailed] = useState(false);

  useEffect(() => {
    const fit = fitRef.current;
    const canvas = canvasRef.current;
    if (!fit || !canvas) return;
    const ro = new ResizeObserver(() => fitCanvas(canvas, fit.clientWidth));
    ro.observe(fit);
    fitCanvas(canvas, fit.clientWidth);
    return () => ro.disconnect();
  }, [fitRef, canvasRef]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let seats: Map<string, Seat> = new Map();
    let seatedFor: OfficeState | null = null;
    let sprites: Sprites | null = null;
    let raf = 0;
    let last = 0;
    let alive = true;

    const frame = (t: number) => {
      raf = 0;
      const st = store.current.state;
      if (!sprites || document.hidden) return;
      const dt = last ? t - last : 0;
      last = t;
      if (st) {
        if (st !== seatedFor) {
          seats = assignSeats(seats, st.characters.values());
          seatedFor = st;
        }
        poses.current = advancePoses(poses.current, st, seats, dt, store.current.loadedAt, reducedMotion);
        drawOffice(ctx, st, poses.current, sprites, Date.now());
        followTip(ctx.canvas, poses.current, tip.current);
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf || !alive || !sprites || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const onVisible = () => {
      if (!document.hidden) start();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    loadSprites().then(
      (s) => {
        sprites = s;
        start();
      },
      () => {
        if (alive) setSpritesFailed(true);
      },
    );
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [canvasRef, store, tip]);

  return { poses, spritesFailed };
}

// Where a character's head is, in CSS pixels from the canvas corner.
function headAt(canvas: HTMLCanvasElement, pose: Pose): Point | null {
  const width = canvas.getBoundingClientRect().width;
  if (width === 0) return null;
  const ratio = canvas.width / width;
  const { scale, ox, oy } = officeLayout(canvas.width, canvas.height);
  const unit = scale * TILE;
  return { left: (ox + (pose.x + 0.5) * unit) / ratio, top: (oy + pose.y * unit) / ratio };
}

// Keeps an open tooltip over its character while it walks, without a React render per frame.
function followTip(canvas: HTMLCanvasElement, poses: Map<string, Pose>, tip: { id: string | null; el: HTMLDivElement | null }): void {
  const pose = tip.id ? poses.get(tip.id) : undefined;
  const at = pose && tip.el ? headAt(canvas, pose) : null;
  if (!at || !tip.el) return;
  tip.el.style.left = `${at.left}px`;
  tip.el.style.top = `${at.top}px`;
}

// Which character sits under a pointer; the front-most one wins.
function hitTest(canvas: HTMLCanvasElement, st: OfficeState, poses: Map<string, Pose>, clientX: number, clientY: number): string | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return null;
  const ratio = canvas.width / rect.width;
  const { scale, ox, oy } = officeLayout(canvas.width, canvas.height);
  const unit = scale * TILE;
  const mx = ((clientX - rect.left) * ratio - ox) / unit;
  const my = ((clientY - rect.top) * ratio - oy) / unit;
  let hit: { id: string; pose: Pose } | null = null;
  for (const c of st.characters.values()) {
    const p = poses.get(c.id);
    if (!p || mx < p.x || mx >= p.x + 1 || my < p.y - 0.25 || my >= p.y + 1) continue;
    if (!hit || p.y > hit.pose.y) hit = { id: c.id, pose: p };
  }
  return hit?.id ?? null;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ActivityList({ view }: { view: OfficeState | null }) {
  if (!view) return <div className="feed-empty">Opening the office…</div>;
  const everyone = [...view.characters.values()];
  const clients = everyone.filter((c) => c.kind === "client").sort(byLabel);
  const workers = everyone.filter((c) => c.kind === "worker").sort(byLabel);
  return (
    <>
      {clients.length === 0 && <p className="office-note">No apps have used this brain in the last day.</p>}
      <ul className="office-people">
        {[...clients, ...workers].map((c) => (
          <li key={c.id} className={c.kind === "worker" && !c.enabled ? "office-off" : undefined}>{lineFor(c)}</li>
        ))}
      </ul>
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

export function OfficePage() {
  const { store, view, feed, error } = useOffice();
  const fitRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<{ id: string | null; el: HTMLDivElement | null }>({ id: null, el: null });
  const { poses, spritesFailed } = useOfficeCanvas(fitRef, canvasRef, store, tipRef);
  const [tipId, setTipId] = useState<string | null>(null);
  useEffect(() => {
    tipRef.current.id = tipId;
  }, [tipId]);

  const under = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const st = store.current.state;
    return st ? hitTest(e.currentTarget, st, poses.current, e.clientX, e.clientY) : null;
  };
  // A second tap on the same figure closes its tooltip.
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const id = under(e);
    setTipId((open) => (e.pointerType !== "mouse" && id !== null && open === id ? null : id));
  };
  const tipped = tipId ? view?.characters.get(tipId) : undefined;
  const tipPose = tipId ? poses.current.get(tipId) : undefined;
  const tipAt = tipped && tipPose && canvasRef.current ? headAt(canvasRef.current, tipPose) : null;

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
      {spritesFailed && <div className="warning-bar">The office pictures could not be loaded. The list still updates.</div>}

      <div className="office-layout">
        <div className="panel office-stage">
          <div className="office-fit" ref={fitRef}>
            <div className="office-canvas-box">
              <canvas
                ref={canvasRef}
                className="office-canvas"
                role="img"
                aria-label="Office floor plan with a figure for each app and background worker"
                onPointerMove={(e) => { if (e.pointerType === "mouse") setTipId(under(e)); }}
                onPointerDown={onDown}
                onPointerLeave={(e) => { if (e.pointerType === "mouse") setTipId(null); }}
              />
              {tipped && tipAt && (
                <div
                  className="office-tip"
                  aria-hidden="true"
                  ref={(el) => { tipRef.current.el = el; }}
                  style={{ left: tipAt.left, top: tipAt.top }}
                >
                  {lineFor(tipped)}
                </div>
              )}
            </div>
          </div>
        </div>
        <section className="panel office-side">
          <h2 className="panel-title">Who is here</h2>
          <div className="office-list" aria-live="polite">
            <ActivityList view={view} />
          </div>
        </section>
      </div>
    </>
  );
}
