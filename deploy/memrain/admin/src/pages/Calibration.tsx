import { useState, useEffect } from "react";
import { api } from "../api";
import { PageIntro } from "../components/PageIntro.tsx";

interface Profile {
  generated_at: string;
  total_graded: number;
  correct: number;
  incorrect: number;
  partial: number;
  unresolvable: number;
  accuracy: number | null;
  pattern_statements: string[];
  bias_tags: string[];
  model_id: string;
}

export function CalibrationPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.calibrationProfile()
      .then((r: { profile: Profile | null }) => { setProfile(r.profile); setLoaded(true); })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

  return (
    <>
      <h1 className="page-title">Calibration</h1>
      <PageIntro>
        How well the brain's predictions held up once their outcome was known. A well-calibrated brain that says 70% is
        right about 70% of the time.
      </PageIntro>
      {error && <div className="warning-bar">{error}</div>}

      {loaded && !profile ? (
        <div className="feed-empty">
          No calibration profile yet. It is computed by the synthesis calibration cycle phase once graded takes exist.
        </div>
      ) : !profile ? (
        <div className="feed-empty">Loading…</div>
      ) : (
        <>
          <div className="metrics">
            <div className="metric"><div className="metric-value">{pct(profile.accuracy)}</div><div className="metric-label">Accuracy</div></div>
            <div className="metric"><div className="metric-value">{profile.total_graded}</div><div className="metric-label">Graded</div></div>
            <div className="metric"><div className="metric-value">{profile.correct}</div><div className="metric-label">Correct</div></div>
            <div className="metric"><div className="metric-value">{profile.incorrect}</div><div className="metric-label">Incorrect</div></div>
          </div>

          <h2 className="section-title">Breakdown</h2>
          <div className="health-panel" style={{ maxWidth: 360 }}>
            <div className="health-row"><span>Partial</span><span className="mono">{profile.partial}</span></div>
            <div className="health-row"><span>Unresolvable</span><span className="mono">{profile.unresolvable}</span></div>
            <div className="health-row"><span>Model</span><span className="mono">{profile.model_id}</span></div>
            <div className="health-row"><span>Generated</span><span className="mono">{new Date(profile.generated_at).toLocaleString()}</span></div>
          </div>

          {profile.bias_tags.length > 0 && (
            <>
              <h2 className="section-title">Bias tags</h2>
              <div>{profile.bias_tags.map((t, i) => <span key={`${t}:${i}`} className="badge badge-admin" style={{ marginRight: 6 }}>{t}</span>)}</div>
            </>
          )}

          {profile.pattern_statements.length > 0 && (
            <>
              <h2 className="section-title">Pattern statements</h2>
              <ul style={{ paddingLeft: 18, color: "var(--text-secondary)", fontSize: 13 }}>
                {profile.pattern_statements.map((s, i) => <li key={i} style={{ marginBottom: 6 }}>{s}</li>)}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
