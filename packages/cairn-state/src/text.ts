/**
 * Get the 1-based line number for a given character index in a text string.
 */
export function lineOf(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1;
    }
  }
  return line;
}
