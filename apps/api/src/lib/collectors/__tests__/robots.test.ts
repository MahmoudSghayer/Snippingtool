import { describe, expect, it } from 'vitest';

import { isAllowed, parseRobots, pathAndQueryOf } from '../robots.js';

const UA = 'SnipersLedger/0.1 (+https://snipersledger.app/bot)';

describe('parseRobots — group selection', () => {
  it('falls back to the * group when nothing names us', () => {
    const robots = parseRobots(['User-agent: *', 'Disallow: /private'].join('\n'), UA);
    expect(robots.matchedAgent).toBe('*');
    expect(isAllowed(robots, '/private/thing')).toBe(false);
    expect(isAllowed(robots, '/public')).toBe(true);
  });

  it('a group naming us REPLACES the * group rather than merging with it', () => {
    // This is the rule naive parsers get wrong, and getting it wrong is what
    // would have us ignore a site's explicit instruction about us: here the
    // `*` group forbids /data, but our own group permits everything.
    const robots = parseRobots(
      ['User-agent: *', 'Disallow: /data', '', 'User-agent: SnipersLedger', 'Allow: /'].join('\n'),
      UA,
    );
    expect(robots.matchedAgent).toBe('snipersledger');
    expect(isAllowed(robots, '/data/prices')).toBe(true);
  });

  it('honours a named group that forbids us even when * is permissive', () => {
    const robots = parseRobots(
      ['User-agent: *', 'Allow: /', '', 'User-agent: SnipersLedger', 'Disallow: /'].join('\n'),
      UA,
    );
    expect(robots.matchedAgent).toBe('snipersledger');
    expect(isAllowed(robots, '/anything')).toBe(false);
  });

  it('picks the most specific of several matching agent tokens', () => {
    const robots = parseRobots(
      ['User-agent: Snipers', 'Disallow: /', '', 'User-agent: SnipersLedger', 'Allow: /'].join(
        '\n',
      ),
      UA,
    );
    expect(robots.matchedAgent).toBe('snipersledger');
    expect(isAllowed(robots, '/x')).toBe(true);
  });

  it('accumulates consecutive User-agent lines into one group', () => {
    const robots = parseRobots(
      ['User-agent: FooBot', 'User-agent: SnipersLedger', 'Disallow: /shared'].join('\n'),
      UA,
    );
    expect(isAllowed(robots, '/shared/x')).toBe(false);
  });
});

describe('parseRobots — rules', () => {
  it('treats an empty Disallow as "allow everything"', () => {
    const robots = parseRobots(['User-agent: *', 'Disallow:'].join('\n'), UA);
    expect(isAllowed(robots, '/anything')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const robots = parseRobots(
      ['# a comment', 'User-agent: *', '', 'Disallow: /x  # trailing'].join('\n'),
      UA,
    );
    expect(isAllowed(robots, '/x')).toBe(false);
  });

  it('longest match wins, and Allow breaks an exact tie', () => {
    const robots = parseRobots(['User-agent: *', 'Disallow: /a', 'Allow: /a/b'].join('\n'), UA);
    expect(isAllowed(robots, '/a/other')).toBe(false);
    expect(isAllowed(robots, '/a/b/c')).toBe(true);
  });

  it('supports * wildcards and $ anchors', () => {
    const robots = parseRobots(
      ['User-agent: *', 'Disallow: /*/private', 'Disallow: /report$'].join('\n'),
      UA,
    );
    expect(isAllowed(robots, '/team/private/x')).toBe(false);
    expect(isAllowed(robots, '/report')).toBe(false);
    // $ anchors, so a longer path is not caught by that rule.
    expect(isAllowed(robots, '/reports/weekly')).toBe(true);
  });

  it('matches rules against the query string too', () => {
    const robots = parseRobots(['User-agent: *', 'Disallow: /players?*'].join('\n'), UA);
    expect(isAllowed(robots, pathAndQueryOf('https://x.test/players?page=2'))).toBe(false);
    expect(isAllowed(robots, pathAndQueryOf('https://x.test/players'))).toBe(true);
  });

  it('allows anything when no rule matches', () => {
    const robots = parseRobots(['User-agent: *', 'Disallow: /nope'].join('\n'), UA);
    expect(isAllowed(robots, '/fine')).toBe(true);
  });
});

describe('parseRobots — against real-world shapes', () => {
  it('handles the futwiz shape: * allowed, named AI crawlers blocked', () => {
    const text = [
      'User-agent: *',
      'Content-Signal: search=yes,ai-train=no',
      'Allow: /',
      'User-agent: ClaudeBot',
      'Disallow: /',
      'User-agent: GPTBot',
      'Disallow: /',
      'User-agent: *',
      'Disallow: /en/chemistry/position*',
    ].join('\n');

    const us = parseRobots(text, UA);
    expect(us.matchedAgent).toBe('*');
    expect(isAllowed(us, '/en/players')).toBe(true);
    expect(isAllowed(us, '/en/chemistry/position/cb')).toBe(false);

    // A named AI crawler gets its own, total, prohibition — the exact case
    // the group-replacement rule above exists to respect.
    const claude = parseRobots(text, 'ClaudeBot/1.0');
    expect(claude.matchedAgent).toBe('claudebot');
    expect(isAllowed(claude, '/en/players')).toBe(false);
  });
});
