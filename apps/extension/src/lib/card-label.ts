/*
 * card-label.ts — how the panel and the assist confirm overlay name a card:
 * its name and rating from the listing's item data when it carried them
 * (`TrimmedAuction.name`), else its resource id.
 */

/** "Name 86", "Name", or "#resourceId". */
export function cardLabel(c: { resourceId: number; name?: string; rating?: number }): string {
  if (!c.name) return `#${c.resourceId}`;
  return c.rating ? `${c.name} ${c.rating}` : c.name;
}
