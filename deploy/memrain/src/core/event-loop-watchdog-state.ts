export interface WatchdogState { observedAt: number; heartbeatAt: number; sequence: bigint; beats: number; tripped: boolean }
export function observeWatchdog(state: WatchdogState, now: number, heartbeatAt: number, sequence: bigint, timeoutMs: number): WatchdogState {
  const starved = now - state.observedAt > 3000 || now < state.observedAt;
  const changed = sequence !== state.sequence;
  const beats = Math.min(2, state.beats + Number(changed));
  const lastBeat = starved ? now : changed ? Math.max(state.heartbeatAt, heartbeatAt) : state.heartbeatAt;
  return { observedAt: now, heartbeatAt: lastBeat, sequence, beats,
    tripped: !starved && beats >= 2 && now - lastBeat >= timeoutMs };
}
