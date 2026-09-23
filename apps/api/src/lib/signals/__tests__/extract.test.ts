// Signal extraction, against a stubbed client — no key, no network.
//
// What's worth testing here isn't the happy path. This is the first part of
// the system whose output can be wrong in a way that reads as right, so the
// cases below are mostly about *refusing* bad output: a truncated response
// that still parses, a signal that targets nothing, a refusal returned as a
// clean HTTP 200. Each of those would otherwise be written to the database
// and counted in a precision number as if it were a real extraction.

import { describe, expect, it, vi } from 'vitest';

import {
  EXTRACTION_MODEL,
  extractSignals,
  SignalExtractionError,
  SYSTEM_PROMPT,
  type MessagesClient,
} from '../extract.js';

const ARTICLE = {
  title: 'Pitch Notes — Title Update 5',
  summary: 'Gameplay changes.',
  body: 'The Rapid PlayStyle has been reduced in effectiveness for players above 90 pace.',
};

/** Builds a stub response with only the fields the extractor reads. */
function reply(
  body: unknown,
  overrides: Partial<{ stop_reason: string; content: unknown[] }> = {},
) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 },
    ...overrides,
  } as never;
}

function stub(response: unknown): { client: MessagesClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client = {
    create: vi.fn(async (params: unknown) => {
      calls.push(params);
      return response as never;
    }),
  } as unknown as MessagesClient;
  return { client, calls };
}

const COHORT_SIGNAL = {
  direction: 'down',
  magnitude: 'moderate',
  confidence: 0.7,
  playerName: null,
  cohort: { playstyle: 'Rapid' },
  evidence: 'The Rapid PlayStyle has been reduced in effectiveness',
  rationale: 'A nerf to a playstyle lowers demand for cards carrying it.',
};

describe('extractSignals — request shape', () => {
  it('sends the model, schema-constrained output and a cached system prefix', async () => {
    const { client, calls } = stub(reply({ signals: [] }));

    await extractSignals(ARTICLE, client);

    const params = calls[0] as {
      model: string;
      output_config: { format: { type: string } };
      system: unknown;
    };
    expect(params.model).toBe(EXTRACTION_MODEL);
    // Structured output is what keeps the response parseable at all.
    expect(params.output_config.format).toMatchObject({ type: 'json_schema' });
    // The instructions are identical for every article, so they must be the
    // cached prefix — otherwise every call pays full rate for them.
    expect(params.system).toEqual([
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('truncates an overlong article rather than sending it whole, and says so', async () => {
    const { client, calls } = stub(reply({ signals: [] }));

    await extractSignals({ ...ARTICLE, body: 'x'.repeat(40_000) }, client);

    const content = (calls[0] as { messages: { content: string }[] }).messages[0]!.content;
    expect(content.length).toBeLessThan(30_000);
    expect(content).toContain('[article truncated at');
  });
});

describe('extractSignals — accepting good output', () => {
  it('returns a cohort-targeted signal', async () => {
    const { client } = stub(reply({ signals: [COHORT_SIGNAL] }));

    const out = await extractSignals(ARTICLE, client);

    expect(out.signals).toHaveLength(1);
    expect(out.signals[0]!.cohort).toEqual({ playstyle: 'Rapid' });
    expect(out.signals[0]!.playerName).toBeNull();
    expect(out.model).toBe(EXTRACTION_MODEL);
  });

  it('accepts an empty result — the common, correct answer', async () => {
    // Most EA posts announce content without saying anything about prices.
    // An extractor that can never return nothing is one that invents.
    const { client } = stub(reply({ signals: [] }));

    const out = await extractSignals(ARTICLE, client);
    expect(out.signals).toEqual([]);
  });

  it('reports cache reads so a broken cache prefix is visible', async () => {
    const { client } = stub(reply({ signals: [] }));
    const out = await extractSignals(ARTICLE, client);
    expect(out.usage.cacheReadTokens).toBe(80);
  });
});

describe('extractSignals — refusing untrustworthy output', () => {
  it('rejects a refusal instead of parsing its body', async () => {
    // A refusal is HTTP 200 with readable content. Reading it as data is how
    // a safety decline becomes a "signal".
    const { client } = stub(
      reply({ signals: [] }, { stop_reason: 'refusal', content: [{ type: 'text', text: '{}' }] }),
    );

    await expect(extractSignals(ARTICLE, client)).rejects.toBeInstanceOf(SignalExtractionError);
  });

  it('rejects a max_tokens truncation even though the JSON may parse', async () => {
    const { client } = stub(reply({ signals: [COHORT_SIGNAL] }, { stop_reason: 'max_tokens' }));

    await expect(extractSignals(ARTICLE, client)).rejects.toThrow(/truncated/i);
  });

  it('rejects malformed JSON', async () => {
    const { client } = stub(reply('{not json'));
    await expect(extractSignals(ARTICLE, client)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects an empty response body', async () => {
    const { client } = stub(reply('   '));
    await expect(extractSignals(ARTICLE, client)).rejects.toThrow(/no text content/);
  });

  it('rejects a signal that targets both a player and a cohort', async () => {
    // Ambiguous targeting would be stored as one or the other by whichever
    // branch ran first — a silent, unreviewable choice.
    const { client } = stub(reply({ signals: [{ ...COHORT_SIGNAL, playerName: 'Haaland' }] }));

    await expect(extractSignals(ARTICLE, client)).rejects.toThrow(/exactly one/);
  });

  it('rejects a signal that targets neither', async () => {
    const { client } = stub(
      reply({ signals: [{ ...COHORT_SIGNAL, playerName: null, cohort: null }] }),
    );

    await expect(extractSignals(ARTICLE, client)).rejects.toThrow(/exactly one/);
  });

  it('rejects an empty cohort that constrains nothing', async () => {
    // `{}` matches every card in the game — a signal about everything is a
    // signal about nothing, and would poison any cohort aggregate.
    const { client } = stub(reply({ signals: [{ ...COHORT_SIGNAL, cohort: {} }] }));

    await expect(extractSignals(ARTICLE, client)).rejects.toBeInstanceOf(SignalExtractionError);
  });

  it('rejects an out-of-range confidence', async () => {
    const { client } = stub(reply({ signals: [{ ...COHORT_SIGNAL, confidence: 1.4 }] }));
    await expect(extractSignals(ARTICLE, client)).rejects.toBeInstanceOf(SignalExtractionError);
  });

  it('rejects an unknown direction rather than coercing it', async () => {
    const { client } = stub(reply({ signals: [{ ...COHORT_SIGNAL, direction: 'sideways' }] }));
    await expect(extractSignals(ARTICLE, client)).rejects.toBeInstanceOf(SignalExtractionError);
  });

  it('rejects extra fields, so a changed output shape is caught not ignored', async () => {
    const { client } = stub(reply({ signals: [{ ...COHORT_SIGNAL, pricePrediction: '-14%' }] }));

    // Specifically: a model that starts volunteering a numeric forecast must
    // fail loudly, not have the field silently dropped.
    await expect(extractSignals(ARTICLE, client)).rejects.toBeInstanceOf(SignalExtractionError);
  });
});
