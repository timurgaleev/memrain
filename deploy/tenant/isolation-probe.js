// Isolation probe. scripts/tenant-isolation-smoke.sh runs it inside one
// tenant container with `bun -e`, so every check sees that container's
// network, credentials and environment. Prints one line per check
// (`ok <check>` / `FAIL <check>: <why>`) and never a secret; exits 1 when any
// check fails.
//
// Input (env):
//   MEMRAIN_POSTGRES_URL  the tenant's own database URL (container env)
//   PROBE_BEDROCK         host:port that must answer (Bedrock runtime)
//   PROBE_NEIGHBOURS      comma-separated host:port that must NOT answer
//   PROBE_IMDS            host:port of the instance metadata service; it must
//                         not answer
//   PROBE_FOREIGN_SECRET  a secret id of another tenant; reading it must fail
//                         for want of credentials or with AccessDenied
import net from "node:net";

const env = process.env;
let failed = false;

function report(ok, check, why) {
  if (!ok) failed = true;
  console.log(ok ? `ok ${check}${why ? ` (${why})` : ""}` : `FAIL ${check}: ${why}`);
}

function hostPort(addr, fallbackPort) {
  const i = addr.lastIndexOf(":");
  if (i <= 0) return [addr, fallbackPort];
  return [addr.slice(0, i), Number(addr.slice(i + 1))];
}

// "open", or why the connection did not happen.
function tcp(host, port, ms) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(ms, () => done("timeout"));
    sock.once("connect", () => done("open"));
    sock.once("error", (e) => done(e.code || "error"));
  });
}

let pg = null;
try {
  pg = new URL(env.MEMRAIN_POSTGRES_URL || "");
} catch {
  report(false, "rds", "MEMRAIN_POSTGRES_URL is missing or not a URL");
}
if (pg) {
  const r = await tcp(pg.hostname, Number(pg.port || 5432), 5000);
  report(r === "open", "rds", r === "open" ? "" : `database host does not answer (${r})`);
}

{
  const [h, p] = hostPort(env.PROBE_BEDROCK || "", 443);
  const r = h ? await tcp(h, p, 5000) : "no address";
  report(r === "open", "bedrock", r === "open" ? "" : `${h}:${p} does not answer (${r})`);
}

for (const target of (env.PROBE_NEIGHBOURS || "").split(",").filter(Boolean)) {
  const [h, p] = hostPort(target, 18790);
  const r = await tcp(h, p, 3000);
  report(r !== "open", "neighbour", r === "open" ? `${h}:${p} accepts connections` : `${h}:${p} ${r}`);
}

try {
  const res = await fetch(`http://${env.PROBE_IMDS}/latest/api/token`, {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
    signal: AbortSignal.timeout(3000),
  });
  report(false, "imds", `answered HTTP ${res.status}`);
} catch {
  report(true, "imds", "no answer");
}

if (env.PROBE_FOREIGN_SECRET) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: env.AWS_REGION || "eu-west-1", maxAttempts: 1 });
  const what = env.PROBE_FOREIGN_SECRET;
  try {
    await client.send(new GetSecretValueCommand({ SecretId: what }), { abortSignal: AbortSignal.timeout(20000) });
    report(false, "secrets", `${what} was readable`);
  } catch (e) {
    const name = e?.name || "Error";
    if (name === "CredentialsProviderError") report(true, "secrets", `${what}: no AWS credentials in the container`);
    else if (name === "AccessDeniedException") report(true, "secrets", `${what}: access denied`);
    else report(false, "secrets", `${what}: ${name} (only no credentials or AccessDenied pass)`);
  }
} else {
  report(false, "secrets", "no foreign secret id to probe");
}

process.exit(failed ? 1 : 0);
