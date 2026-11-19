import { useState } from "react";
import { chatApi, actionErrorText } from "./chat-api.ts";

type Rating = -1 | 0 | 1;

/**
 * Useful / not useful on one source of an answer. Pressing the pressed button
 * again withdraws the rating. The server keeps the rating only to rank that
 * page a little higher or lower in later searches.
 */
export function Feedback({ messageId, slug, title }: { messageId: string; slug: string; title: string }) {
  const [rating, setRating] = useState<Rating>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async (pressed: Exclude<Rating, 0>) => {
    const next: Rating = rating === pressed ? 0 : pressed;
    setBusy(true);
    setError("");
    try {
      await chatApi.rate(messageId, slug, next);
      setRating(next);
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="chat-rate" role="group" aria-label={`Rate source: ${title}`}>
      <button
        type="button"
        className="chat-rate-btn"
        aria-pressed={rating === 1}
        aria-label="Useful"
        title="Useful"
        disabled={busy}
        onClick={() => void send(1)}
      >
        <Thumb />
      </button>
      <button
        type="button"
        className="chat-rate-btn chat-rate-down"
        aria-pressed={rating === -1}
        aria-label="Not useful"
        title="Not useful"
        disabled={busy}
        onClick={() => void send(-1)}
      >
        <Thumb />
      </button>
      {error && <span className="error-text small" role="alert">{error}</span>}
    </span>
  );
}

function Thumb() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M7 10v11H3V10h4Zm2 11h8.3a2 2 0 0 0 2-1.6l1.4-7A2 2 0 0 0 18.7 10H14l.8-4.2A1.6 1.6 0 0 0 13.2 4L9 10v11Z"
        fill="currentColor"
      />
    </svg>
  );
}
