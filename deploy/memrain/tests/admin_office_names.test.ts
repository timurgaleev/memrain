import { describe, expect, it } from "bun:test";
import type { FeedEvent, OfficeSnapshot } from "../admin/src/admin-types.ts";
import { applyEvent, applySnapshot, initialState, namesFromSnapshot, type OfficeState } from "../admin/src/office/model.ts";

const NOW = 1_000_000;
const empty: OfficeState = { characters: new Map(), recent: [] };
const C = (id: string) => `client:${id}`;

function ev(p: Partial<FeedEvent> & { agent: string }): FeedEvent {
  return { operation: "search", latency_ms: 1, status: "success", timestamp: "", ...p };
}

describe("long app names", () => {
  const long = "A very long app name that someone typed into the client settings";
  const snap: OfficeSnapshot = {
    workers: [],
    clients: [{ id: "c1", display_name: long, last_seen: new Date(NOW).toISOString() }],
  };

  it("cuts a long name to 40 characters with an ellipsis everywhere it is shown", () => {
    const want = `${long.slice(0, 39)}…`;
    expect(initialState(snap, NOW).characters.get(C("c1"))!.label).toBe(want);
    expect(namesFromSnapshot(snap).get(C("c1"))).toBe(want);
    const renamed = applySnapshot(initialState({ ...snap, clients: [{ ...snap.clients[0]!, display_name: "Laptop" }] }, NOW), snap, NOW, NOW + 1);
    expect(renamed.characters.get(C("c1"))!.label).toBe(want);
    const viaEvent = applyEvent(empty, ev({ agent: "c1", kind: "tool" }), NOW, namesFromSnapshot(snap));
    expect(viaEvent.characters.get(C("c1"))!.label).toBe(want);
    expect([...want].length).toBe(40);
  });

  it("keeps a name of 40 characters or fewer as it is, and never splits a character in two", () => {
    const forty = "x".repeat(40);
    const st = initialState({ ...snap, clients: [{ ...snap.clients[0]!, display_name: forty }] }, NOW);
    expect(st.characters.get(C("c1"))!.label).toBe(forty);
    const emoji = "\u{1F600}".repeat(45);
    const cut = initialState({ ...snap, clients: [{ ...snap.clients[0]!, display_name: emoji }] }, NOW).characters.get(C("c1"))!.label;
    expect([...cut].length).toBe(40);
    expect(cut).toBe(`${"\u{1F600}".repeat(39)}…`);
  });
});
