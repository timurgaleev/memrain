/**
 * OAuth scope hierarchy. Pure logic, no DB. Guards the invariants the auth
 * layer depends on — most importantly that `admin` does NOT imply `agent`
 * (a future "admin implies all" refactor must fail here, not in production).
 */
import { describe, expect, it } from "bun:test";
import {
  assertAllowedScopes,
  hasScope,
  intersectGrantedScopes,
  InvalidScopeError,
  isScope,
  normalizeScopesInput,
  parseScopeString,
} from "../src/core/scope.ts";

describe("hasScope", () => {
  it("admin implies write and read but NOT agent", () => {
    expect(hasScope(["admin"], "read")).toBe(true);
    expect(hasScope(["admin"], "write")).toBe(true);
    expect(hasScope(["admin"], "agent")).toBe(false);
  });

  it("write implies read, not the reverse", () => {
    expect(hasScope(["write"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
  });

  it("the retired *_admin names are not scopes and satisfy nothing", () => {
    expect(isScope("sources_admin")).toBe(false);
    expect(isScope("users_admin")).toBe(false);
    expect(hasScope(["sources_admin", "users_admin"], "read")).toBe(false);
    expect(() => normalizeScopesInput(["read", "sources_admin"])).toThrow(InvalidScopeError);
  });

  it("ignores unknown granted scopes without throwing", () => {
    expect(hasScope(["bogus"], "read")).toBe(false);
    expect(hasScope(["bogus", "read"], "read")).toBe(true);
  });
});

describe("intersectGrantedScopes", () => {
  it("intersects capabilities, not spellings", () => {
    expect(intersectGrantedScopes(["admin"], ["write"])).toEqual(["write"]);
    expect(intersectGrantedScopes(["admin"], ["read"])).toEqual(["read"]);
    expect(intersectGrantedScopes(["read", "write"], ["read"])).toEqual(["read"]);
    expect(intersectGrantedScopes(["read", "write"], ["read", "write"])).toEqual(["read", "write"]);
  });

  it("never adds what the token was not issued", () => {
    expect(intersectGrantedScopes(["read"], ["admin"])).toEqual(["read"]);
    expect(intersectGrantedScopes(["write"], ["admin", "agent"])).toEqual(["write"]);
    expect(intersectGrantedScopes(["admin"], ["admin", "agent"])).toEqual(["admin"]);
  });

  it("is empty when nothing is left, and ignores unknown names", () => {
    expect(intersectGrantedScopes(["agent"], ["read", "write"])).toEqual([]);
    expect(intersectGrantedScopes(["read"], [])).toEqual([]);
    expect(intersectGrantedScopes(["sources_admin"], ["admin"])).toEqual([]);
    expect(intersectGrantedScopes(["read"], ["bogus"])).toEqual([]);
  });
});

describe("normalizeScopesInput", () => {
  it("defaults to read, sorts + dedupes", () => {
    expect(normalizeScopesInput(null)).toBe("read");
    expect(normalizeScopesInput("write read read")).toBe("read write");
    expect(normalizeScopesInput(["write", "read"])).toBe("read write");
  });

  it("rejects unknown scopes and malformed arrays", () => {
    expect(() => normalizeScopesInput(["read", "boss"])).toThrow(InvalidScopeError);
    expect(() => normalizeScopesInput(["read write"])).toThrow(/whitespace/);
    expect(() => normalizeScopesInput([42 as unknown as string])).toThrow(/only strings/);
  });
});

describe("parse + assert helpers", () => {
  it("parseScopeString splits and drops empties", () => {
    expect(parseScopeString("read  write")).toEqual(["read", "write"]);
    expect(parseScopeString(undefined)).toEqual([]);
  });

  it("assertAllowedScopes throws on the first unknown", () => {
    expect(() => assertAllowedScopes(["read", "nope"])).toThrow(InvalidScopeError);
    expect(() => assertAllowedScopes(["read", "write", "admin"])).not.toThrow();
  });
});
