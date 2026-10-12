/**
 * Product gate for Cindy Make.
 *
 * Cindy Make remains on disk so existing source checkouts, history and personal
 * builds are not removed, but the product surface is currently unavailable to
 * users. Keep this value shared by desktop and mobile so a build cannot expose
 * one client while hiding the other.
 */
export const CINDY_MAKE_ENABLED = false;

export function isCindyMakeSource(source: string | null | undefined): boolean {
  return source === 'cindy-make' || source === 'cindy-make-merge';
}
