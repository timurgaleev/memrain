/**
 * The same-origin guard on state-changing POSTs.
 *
 * The case that matters is the one the first version got wrong: Claude opens
 * `/authorize` in a popup, so the page arrives cross-site, and Chrome stamps the
 * form's own POST `Sec-Fetch-Site: cross-site` even though the form came from
 * us. Vetoing on that header refused every real connector submit while every
 * curl test — which sends no fetch-metadata at all — stayed green. `Origin` is
 * the header that actually answers "who served this form".
 */
import { afterEach, describe, expect, it } from "bun:test";
import { isSameOriginPost } from "../src/http/same-origin.ts";

const TARGET = new URL("https://brain.example/authorize?x=1");

function post(headers: Record<string, string>): Request {
  return new Request(TARGET.href, { method: "POST", headers });
}

describe("isSameOriginPost", () => {
  it("accepts our own form even when the popup navigation reads cross-site", () => {
    // The regression: this is exactly what a real browser sends for the
    // enrollment submit inside Claude's connector popup.
    expect(isSameOriginPost(post({ origin: "https://brain.example", "sec-fetch-site": "cross-site" }), TARGET)).toBe(true);
    expect(isSameOriginPost(post({ origin: "https://brain.example", "sec-fetch-site": "same-site" }), TARGET)).toBe(true);
    expect(isSameOriginPost(post({ origin: "https://brain.example", "sec-fetch-site": "same-origin" }), TARGET)).toBe(true);
  });

  it("refuses a foreign origin however the fetch metadata is dressed", () => {
    for (const site of ["cross-site", "same-site", "same-origin", "none"]) {
      expect(isSameOriginPost(post({ origin: "https://evil.example", "sec-fetch-site": site }), TARGET)).toBe(false);
    }
    expect(isSameOriginPost(post({ origin: "https://evil.example" }), TARGET)).toBe(false);
  });

  it("refuses an origin that is not a bare serialized origin", () => {
    // Both parse to our host. No browser writes either, so accepting them buys
    // nothing and costs the guard its meaning.
    expect(isSameOriginPost(post({ origin: "https://evil.example@brain.example/path" }), TARGET)).toBe(false);
    expect(isSameOriginPost(post({ origin: "null://brain.example" }), TARGET)).toBe(false);
    expect(isSameOriginPost(post({ origin: "https://brain.example/" }), TARGET)).toBe(false);
  });

  it("refuses an opaque origin", () => {
    // A sandboxed frame or a redirect-originated POST sends this; it parses to
    // nothing, so it must not fall through to the permissive branch.
    expect(isSameOriginPost(post({ origin: "null" }), TARGET)).toBe(false);
  });

  it("distinguishes a sibling subdomain, which is same-site but not same-origin", () => {
    expect(isSameOriginPost(post({ origin: "https://other.example" }), TARGET)).toBe(false);
  });

  it("falls back to fetch metadata only when no origin was sent", () => {
    expect(isSameOriginPost(post({ "sec-fetch-site": "same-origin" }), TARGET)).toBe(true);
    expect(isSameOriginPost(post({ "sec-fetch-site": "same-site" }), TARGET)).toBe(false);
    expect(isSameOriginPost(post({ "sec-fetch-site": "cross-site" }), TARGET)).toBe(false);
    expect(isSameOriginPost(post({ "sec-fetch-site": "none" }), TARGET)).toBe(false);
  });

  it("lets a non-browser caller through, which sends neither header", () => {
    expect(isSameOriginPost(post({}), TARGET)).toBe(true);
  });
  it("checks the scheme too: against the configured public origin behind a proxy, against the request itself otherwise", () => {
    // Behind a TLS-terminating proxy the server sees plain http on the same host.
    const internal = new URL("http://brain.example/admin/api/api-keys");
    const at = (origin: string) => new Request(internal.href, { method: "POST", headers: { origin } });
    expect(isSameOriginPost(at("https://brain.example"), internal, "https://brain.example")).toBe(true);
    expect(isSameOriginPost(at("http://brain.example"), internal, "https://brain.example")).toBe(false);
    // A public URL for some other host says nothing about this request.
    expect(isSameOriginPost(at("https://brain.example"), internal, "https://other.example")).toBe(true);
    // Unset: host-only as before, except that a request the server itself saw
    // over https cannot have come from an http page.
    expect(isSameOriginPost(at("https://brain.example"), internal)).toBe(true);
    expect(isSameOriginPost(post({ origin: "http://brain.example" }), TARGET)).toBe(false);
  });
});

describe("isSameOriginPost on a host MEMRAIN_PUBLIC_URL does not name", () => {
  const saved = process.env.MEMRAIN_HTTP_TRUST_PROXY;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMRAIN_HTTP_TRUST_PROXY;
    else process.env.MEMRAIN_HTTP_TRUST_PROXY = saved;
  });

  // [trust proxy, X-Forwarded-Proto, request URL, Origin, expected]
  const table: [boolean, string | null, string, string, boolean][] = [
    [true, "https", "http://alt.example.com/x", "http://alt.example.com", false],
    [true, "https", "http://alt.example.com/x", "https://alt.example.com", true],
    [true, "http", "http://alt.example.com/x", "https://alt.example.com", false],
    // A trusted proxy that sends no header changes nothing.
    [true, null, "http://alt.example.com/x", "http://alt.example.com", true],
    // Without a trusted proxy the header is ignored.
    [false, "https", "http://alt.example.com/x", "http://alt.example.com", true],
    [false, null, "https://alt.example.com/x", "http://alt.example.com", false],
  ];

  it("takes the scheme from a trusted X-Forwarded-Proto", () => {
    for (const [trust, proto, target, origin, expected] of table) {
      if (trust) process.env.MEMRAIN_HTTP_TRUST_PROXY = "1";
      else delete process.env.MEMRAIN_HTTP_TRUST_PROXY;
      const headers: Record<string, string> = { origin };
      if (proto !== null) headers["x-forwarded-proto"] = proto;
      const url = new URL(target);
      const got = isSameOriginPost(new Request(url.href, { method: "POST", headers }), url, "https://brain.example");
      expect({ trust, proto, target, origin, got }).toEqual({ trust, proto, target, origin, got: expected });
    }
  });
});
