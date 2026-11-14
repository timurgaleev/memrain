import { createHash, randomBytes } from "node:crypto";
import type { AuthInfo } from "../../src/core/auth-info.ts";
import type { Engine } from "../../src/core/engine/interface.ts";
import { OAuthProvider } from "../../src/core/oauth-provider.ts";

/**
 * A real personal access token, resolved the way the server resolves a bearer,
 * so a queued ingest job carries a principal the worker can re-check live.
 */
export async function mintIngestPat(
  engine: Engine,
  opts: { name?: string; sourceId?: string } = {},
): Promise<{ name: string; auth: AuthInfo }> {
  const token = `memrain_pat_${randomBytes(24).toString("hex")}`;
  const name = opts.name ?? `ingest-pat-${randomBytes(4).toString("hex")}`;
  await engine.query(
    `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], $4::text::jsonb)`,
    [name, createHash("sha256").update(token, "utf8").digest("hex"), ["read", "write"], JSON.stringify({ source_id: opts.sourceId ?? "default" })],
  );
  const { expiresAt: _e, resource: _r, clientName: _c, ...info } = await new OAuthProvider({ engine }).verifyAccessToken(token);
  return { name, auth: { ...info, isPublic: false } };
}
