/**
 * The admin passkey relying party comes from MEMRAIN_PUBLIC_URL and nothing
 * else: no Host fallback, no forwarded header, no plain-http origin except
 * localhost, no IP literal.
 */
import { describe, expect, it } from "bun:test";
import { resolveRelyingParty } from "../src/core/webauthn-config.ts";

describe("resolveRelyingParty", () => {
  it("derives the rpID (full hostname) and exact origin from an https public URL", () => {
    expect(resolveRelyingParty("https://brain.example.com")).toEqual({
      rpID: "brain.example.com",
      origin: "https://brain.example.com",
      rpName: "memrain",
    });
    expect(resolveRelyingParty("https://brain.example.com:8443/")).toEqual({
      rpID: "brain.example.com",
      origin: "https://brain.example.com:8443",
      rpName: "memrain",
    });
  });

  it("takes no request input, so a Host or forwarded header cannot steer it", () => {
    // The signature has nowhere to pass a request; prove the arity too.
    expect(resolveRelyingParty.length).toBe(1);
    const req = new Request("http://evil.example/admin", {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    expect(req.headers.get("host")).toBe("evil.example");
    expect(resolveRelyingParty("https://brain.example.com")).toMatchObject({ rpID: "brain.example.com" });
  });

  it("is unavailable when the public URL is unset, whatever the request says", () => {
    expect(resolveRelyingParty(undefined)).toEqual({ error: "public_url_unset" });
    expect(resolveRelyingParty("")).toEqual({ error: "public_url_unset" });
    expect(resolveRelyingParty("   ")).toEqual({ error: "public_url_unset" });
  });

  it("accepts plain http only for localhost", () => {
    expect(resolveRelyingParty("http://localhost:3000")).toEqual({
      rpID: "localhost",
      origin: "http://localhost:3000",
      rpName: "memrain",
    });
    expect(resolveRelyingParty("http://brain.example.com")).toEqual({ error: "public_url_not_https" });
  });

  it("refuses IP literals and malformed URLs", () => {
    expect(resolveRelyingParty("https://192.0.2.10")).toEqual({ error: "public_url_invalid" });
    expect(resolveRelyingParty("http://127.0.0.1:8080")).toEqual({ error: "public_url_invalid" });
    expect(resolveRelyingParty("https://[::1]:8443")).toEqual({ error: "public_url_invalid" });
    expect(resolveRelyingParty("not a url")).toEqual({ error: "public_url_invalid" });
    expect(resolveRelyingParty("ftp://brain.example.com")).toEqual({ error: "public_url_invalid" });
  });
});
