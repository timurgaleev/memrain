-- 177_release_truncated_fact_holds.sql — release the facts-backfill pages
-- parked on a truncated reply.
--
-- Each of these pages was parked because the extractor's output cap cut its
-- reply and the parser then threw the whole reply away, the facts that had
-- closed before the cut too. The parser now keeps those facts, and the cap
-- itself has grown since most of these failures, but the backoff is keyed on
-- the page's content and the model only: without this a parked page waits out
-- up to seven days before it is asked again. Ending the wait makes the pages
-- eligible for the next scheduled backfill, under its usual budget and page
-- cap; the attempt count stays, so a page that fails again goes straight back
-- to a long wait. Other failure kinds and other phases keep their backoff.

UPDATE synth_failures SET next_eligible_at = now()
 WHERE phase = 'facts-backfill' AND kind = 'truncated' AND next_eligible_at > now();
