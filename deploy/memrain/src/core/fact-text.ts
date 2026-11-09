/** Preserve speaker attribution when claims are packed into prose. */
export function packFactText(f: { fact: string; attributed_to: string | null }): string {
  return f.attributed_to === "assistant" ? `(assistant said) ${f.fact}` : f.fact;
}
