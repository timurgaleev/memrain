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
//   PROBE_FOREIGN_SECRETS comma-separated secret ids of other tenants and the
//                         control admin URL; reading each must fail
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

const foreign = (env.PROBE_FOREIGN_SECRETS || "").split(",").filter(Boolean);
if (foreign.length > 0) {
  // The instance role is the imds check's job. Here only the credentials the
  // container holds itself (env, files) count. Left on, the SDK's IMDS lookup
  // in the image ran for minutes against a refusing endpoint, past any abort
  // signal, so the lookup is off and the whole check has its own deadline.
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: env.AWS_REGION || "eu-west-1", maxAttempts: 1 });
  // All at once, so a silent endpoint costs one deadline, not one per secret.
  const outcomes = await Promise.all(foreign.map(async (what) => {
    const deadline = new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error("no answer"), { name: "Deadline" })), 30000).unref?.();
    });
    try {
      await Promise.race([
        client.send(new GetSecretValueCommand({ SecretId: what }), { abortSignal: AbortSignal.timeout(20000) }),
        deadline,
      ]);
      return [false, `${what} was readable`];
    } catch (e) {
      const name = e?.name || "Error";
      if (name === "CredentialsProviderError") return [true, `${what}: no AWS credentials in the container`];
      if (name === "AccessDeniedException") return [true, `${what}: access denied`];
      return [false, `${what}: ${name} (only no credentials or AccessDenied pass)`];
    }
  }));
  for (const [ok, why] of outcomes) report(ok, "secrets", why);
} else {
  report(false, "secrets", "no foreign secret id to probe");
}

process.exit(failed ? 1 : 0);
