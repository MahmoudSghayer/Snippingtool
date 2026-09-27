// Starter search filters offered on /account for a new customer to add in
// one click (POST /filters). They are starting points for the FC transfer
// market search, not recommendations: prices move, and nothing here says
// or implies a filter will make coins.
import type { FilterCriteria } from './schemas/filters.js';

export interface StarterFilter {
  /** Stable id for UI keys; never sent to the API. */
  key: string;
  /** Saved as the filter's name (max 80 chars). */
  name: string;
  /** One line on what the search looks for. */
  description: string;
  filter: FilterCriteria;
}

export const STARTER_FILTERS: readonly StarterFilter[] = [
  {
    key: 'gold-rare-82-84',
    name: 'Gold rare 82–84 under 12k',
    description: 'Gold rare players rated 82 to 84, buy now up to 12,000 coins.',
    filter: { quality: 'gold', rarity: 1, minRating: 82, maxRating: 84, maxPrice: 12_000 },
  },
  {
    key: 'fodder-85-86',
    name: '85+ fodder under 20k',
    description: 'Gold players rated 85 to 86, often used in SBCs, up to 20,000 coins.',
    filter: { quality: 'gold', minRating: 85, maxRating: 86, maxPrice: 20_000 },
  },
  {
    key: 'pl-gold-rare',
    name: 'Premier League gold rare under 5k',
    description: 'Gold rare players from the Premier League, up to 5,000 coins.',
    filter: { quality: 'gold', rarity: 1, league: 13, maxPrice: 5_000 },
  },
  {
    key: 'special-86',
    name: 'Special cards 86+ under 50k',
    description: 'Special cards rated 86 or higher, up to 50,000 coins.',
    filter: { quality: 'special', minRating: 86, maxPrice: 50_000 },
  },
];
