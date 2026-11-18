// The whiteboard is built from boxes rather than loaded: a white board in a thin
// aluminium frame on two legs, a marker tray and a few abstract scribbles. Sizes are
// in model units (the furniture kit's), so the usual per-kind scale applies.
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, type BufferGeometry } from "three";

const WIDTH = 0.3;
const HEIGHT = 0.435;
const FRAME = 0.01;
const FRAME_DEPTH = 0.016;
const BOARD_BOTTOM = 0.19;
const BOARD_H = HEIGHT - BOARD_BOTTOM;
const FOOT_DEPTH = 0.14;

export function buildWhiteboard(): Group {
  const box = new BoxGeometry(1, 1, 1);
  const rod = new CylinderGeometry(0.5, 0.5, 1, 6).rotateZ(Math.PI / 2);
  const alu = new MeshStandardMaterial({ color: "#aeb4bb", roughness: 0.45, metalness: 0.5 });
  const white = new MeshStandardMaterial({ color: "#f8f9fb", roughness: 0.35, emissive: "#ffffff", emissiveIntensity: 0.1 });
  const ink = (color: string) => new MeshStandardMaterial({ color, roughness: 0.6 });
  const [blue, red, green] = [ink("#2f6fe0"), ink("#e04a43"), ink("#2fae62")];
  const root = new Group();

  const part = (geo: BufferGeometry, mat: MeshStandardMaterial, size: [number, number, number], at: [number, number, number], roll = 0) => {
    const m = new Mesh(geo, mat);
    m.scale.set(...size);
    m.position.set(...at);
    m.rotation.z = roll;
    root.add(m);
  };

  const cy = BOARD_BOTTOM + BOARD_H / 2;
  part(box, white, [WIDTH - 2 * FRAME, BOARD_H - 2 * FRAME, 0.008], [0, cy, 0]);
  part(box, alu, [WIDTH, FRAME, FRAME_DEPTH], [0, HEIGHT - FRAME / 2, 0]);
  part(box, alu, [WIDTH, FRAME, FRAME_DEPTH], [0, BOARD_BOTTOM + FRAME / 2, 0]);
  for (const s of [-1, 1]) {
    part(box, alu, [FRAME, BOARD_H, FRAME_DEPTH], [s * (WIDTH - FRAME) / 2, cy, 0]);
    // Slim leg under each side, ending in a foot that runs front to back.
    part(box, alu, [0.012, BOARD_BOTTOM, 0.012], [s * 0.115, BOARD_BOTTOM / 2, 0]);
    part(box, alu, [0.018, 0.012, FOOT_DEPTH], [s * 0.115, 0.006, 0]);
  }

  // Tray under the board with a few markers lying in it.
  const trayZ = FRAME_DEPTH / 2 + 0.012;
  part(box, alu, [0.2, 0.008, 0.024], [0, BOARD_BOTTOM - 0.004 + FRAME, trayZ]);
  const markerY = BOARD_BOTTOM + FRAME + 0.004 + 0.004;
  part(rod, blue, [0.03, 0.008, 0.008], [-0.05, markerY, trayZ]);
  part(rod, red, [0.03, 0.008, 0.008], [-0.012, markerY, trayZ + 0.002]);
  part(rod, green, [0.03, 0.008, 0.008], [0.028, markerY, trayZ - 0.001]);

  // Scribbles lie just proud of the board; none of them spell anything.
  const z = 0.0055;
  part(box, blue, [0.11, 0.007, 0.002], [-0.05, cy + 0.078, z]);
  part(box, blue, [0.07, 0.007, 0.002], [-0.07, cy + 0.054, z]);
  part(box, blue, [0.09, 0.007, 0.002], [-0.06, cy + 0.03, z], 0.05);
  part(box, red, [0.05, 0.007, 0.002], [0.07, cy + 0.07, z], 0.7);
  part(box, red, [0.05, 0.007, 0.002], [0.09, cy + 0.07, z], -0.7);
  part(box, red, [0.1, 0.007, 0.002], [0.08, cy + 0.035, z]);
  part(box, green, [0.045, 0.007, 0.002], [-0.075, cy - 0.025, z], 0.6);
  part(box, green, [0.045, 0.007, 0.002], [-0.04, cy - 0.025, z], -0.6);
  part(box, green, [0.045, 0.007, 0.002], [-0.005, cy - 0.025, z], 0.6);
  part(box, green, [0.12, 0.007, 0.002], [0.055, cy - 0.065, z], -0.04);
  return root;
}
