/**
 * A connector request that asks for a text body (a meeting transcript is
 * WebVTT, not JSON) gets the body as a string; every other request still
 * parses JSON and treats anything else as a challenge page.
 */
import { describe, expect, it } from "bun:test";
import { ConnectorClient } from "../src/core/connectors/client.ts";
import { fakeClock, replay } from "./github-recorded.ts";

const ORIGIN = ["https://api", "provider", "test"].join(".");
const TOKEN = ["acc", "ess", "-text-value"].join("");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ada>Hello.</v>\n";

function client(status: number, body: string, contentType: string) {
  const clock = fakeClock();
  const fake = replay([{ status, headers: { "content-type": contentType }, body }]);
  return new ConnectorClient({ origin: ORIGIN, token: TOKEN, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, maxRetries: 0 });
}

describe("ConnectorClient text bodies", () => {
  it("returns the raw body as a string when the request asks for text", async () => {
    const res = await client(200, VTT, "text/vtt").get("/content", { text: true });
    expect(res.class).toBe("ok");
    expect(res.body).toBe(VTT);
  });

  it("still refuses a non-JSON body when the request does not ask for text", async () => {
    const res = await client(200, VTT, "text/vtt").get("/content");
    expect(res.class).toBe("challenge");
    expect(res.body).toBeNull();
  });

  it("keeps a text request's error responses classified as before", async () => {
    const res = await client(403, JSON.stringify({ error: { code: "Forbidden" } }), "application/json").get("/content", { text: true });
    expect(res.class).toBe("forbidden");
    expect(res.errorBody).toEqual({ error: { code: "Forbidden" } });
  });
});
