// robots.txt parsing and path matching.
//
// This is a *gate*, not a formality: docs/14-ml-suggestions.md §4e commits
// the collectors to being polite rather than evasive, and this module is
// where that commitment is actually enforced — `isAllowed()` is consulted
// before every fetch, and a disallowed path is skipped, not worked around.
//
// Implements the parts of the de-facto standard that matter here:
//   - User-agent group selection: the most specific matching group wins, with
//     `*` as the fallback. A named group REPLACES the `*` group rather than
//     adding to it, which is the rule most naive parsers get wrong — being
//     named in robots.txt usually means being restricted, so merging the two
//     would quietly ignore a site's explicit instruction about us.
//   - Allow/Disallow with `*` (any run) and `$` (end anchor).
//   - Longest-match-wins, Allow breaking ties (Google's rule).
//   - An empty `Disallow:` means "allow everything", per the standard.
//
// Not implemented: Crawl-delay (we set our own, more conservative, per-source
// interval in fetcher.ts) and Sitemap (not needed yet).

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsTxt {
  /** Rules for the group that applies to us, already selected. */
  rules: RobotsRule[];
  /** Which `User-agent:` group was selected, for logging/debugging. */
  matchedAgent: string | null;
}

/** A robots.txt we could not fetch or parse. Treated as "allow", matching the
 * standard's guidance that an unreachable robots.txt is not a blanket
 * prohibition — but the caller still sees a 4xx/5xx from the page fetch
 * itself, so this is not a way to sneak past a block. */
export const ROBOTS_ALLOW_ALL: RobotsTxt = { rules: [], matchedAgent: null };

function normaliseAgent(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Parses robots.txt and selects the group applying to `userAgent`.
 *
 * Group selection is by longest matching agent token, case-insensitively,
 * substring-matched — a `User-agent: SnipersLedger` line matches our
 * `SnipersLedger/0.1 (+https://...)` product token.
 */
export function parseRobots(text: string, userAgent: string): RobotsTxt {
  const me = normaliseAgent(userAgent);

  // agent token -> rules. A group can declare several User-agent lines.
  const groups = new Map<string, RobotsRule[]>();
  let currentAgents: string[] = [];
  let sawRuleForCurrentGroup = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;

    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines accumulate into one group; a
      // User-agent line *after* a rule starts a new group.
      if (sawRuleForCurrentGroup) {
        currentAgents = [];
        sawRuleForCurrentGroup = false;
      }
      const agent = normaliseAgent(value);
      currentAgents.push(agent);
      if (!groups.has(agent)) groups.set(agent, []);
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (currentAgents.length === 0) continue; // rule outside any group

    sawRuleForCurrentGroup = true;

    // `Disallow:` with an empty value means "nothing is disallowed"; it is
    // not a rule matching every path, so it is dropped rather than stored.
    if (field === 'disallow' && value === '') continue;
    if (value === '') continue;

    for (const agent of currentAgents) {
      groups.get(agent)!.push({ allow: field === 'allow', path: value });
    }
  }

  // Most specific matching group wins; `*` is the fallback, and a named
  // match replaces it entirely rather than merging.
  let matchedAgent: string | null = null;
  for (const agent of groups.keys()) {
    if (agent === '*') continue;
    if (!me.includes(agent)) continue;
    if (matchedAgent === null || agent.length > matchedAgent.length) matchedAgent = agent;
  }
  if (matchedAgent === null && groups.has('*')) matchedAgent = '*';

  return {
    rules: matchedAgent === null ? [] : (groups.get(matchedAgent) ?? []),
    matchedAgent,
  };
}

/** Converts a robots path pattern (`*` = any run, `$` = end anchor) into a
 * RegExp. Everything else is escaped literally. */
function patternToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      out += '.*';
    } else if (ch === '$' && i === pattern.length - 1) {
      out += '$';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}`);
}

/** Length of the pattern for tie-breaking, ignoring the wildcard characters
 * themselves so `/a/*` does not outrank the more specific `/a/b`. */
function specificity(pattern: string): number {
  return pattern.replace(/[*$]/g, '').length;
}

/**
 * Is `pathname` (path + query, as it would appear after the origin) allowed?
 *
 * Longest matching rule wins; on an exact-length tie, Allow beats Disallow.
 * No matching rule means allowed.
 */
export function isAllowed(robots: RobotsTxt, pathAndQuery: string): boolean {
  let best: { allow: boolean; score: number } | null = null;

  for (const rule of robots.rules) {
    if (!patternToRegExp(rule.path).test(pathAndQuery)) continue;
    const score = specificity(rule.path);
    if (best === null || score > best.score || (score === best.score && rule.allow)) {
      best = { allow: rule.allow, score };
    }
  }

  return best === null ? true : best.allow;
}

/** Convenience: the path+query of a URL, which is what robots rules match. */
export function pathAndQueryOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
