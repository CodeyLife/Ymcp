/**
 * Count visible textual characters in a manuscript.
 *
 * Letters and numbers from every Unicode script count as characters. Punctuation,
 * whitespace, emoji, formatting controls, and other symbols do not.
 */
export function countNovelCharacters(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}
