// Keyboard model of an ARIA tab list: arrows move and wrap, Home/End jump.
// Returns the tab to focus and select, or null when the key is not handled.
export function nextTab(key: string, cur: number, n: number): number | null {
  if (n <= 0) return null;
  switch (key) {
    case "ArrowRight": return (cur + 1) % n;
    case "ArrowLeft": return (cur - 1 + n) % n;
    case "Home": return 0;
    case "End": return n - 1;
    default: return null;
  }
}
