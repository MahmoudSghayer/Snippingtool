// Turning an EA article into structured price signals.
//
// docs/14-ml-suggestions.md puts this last of the four problems on purpose:
// it is the flashiest and the easiest to fake convincingly. An extractor that
// returns a confident-sounding signal for every article will look like it is
// working, and there is no way to notice from the output alone. So three
// things are load-bearing here and none of them are optional:
//
//   1. **Returning nothing is the expected answer.** Most EA posts announce
//      content without saying anything about any player's price. The prompt
//      says so explicitly, and the empty case is tested.
//   2. **Structured output, validated twice.** The JSON Schema is the model's
//      output contract; the Zod schema re-validates what comes back. A shape
//      that slips past one is caught by the other.
//   3. **Nothing it produces is trusted.** Every signal lands with
//      `reviewed_at IS NULL`. The accept/reject record is what turns "the
//      extractor seems good" into a number.
//
// Model choice: `claude-opus-5`. The whole back catalogue is ~70K input
// tokens — under a dollar to process — so there is no cost argument for
// trading away judgement on a task whose failure mode is plausible nonsense.

import Anthropic from '@anthropic-ai/sdk';

import {
  extractionResultSchema,
  EXTRACTION_JSON_SCHEMA,
  PROMPT_VERSION,
  type ExtractedSignal,
} from './schema.js';

export const EXTRACTION_MODEL = 'claude-opus-5';

/**
 * The instruction half of the contract. Kept as a module constant, and first
 * in the request, so it is a stable cache prefix across every article —
 * caching is a prefix match, and the article text is the only part that
 * varies (shared/prompt-caching.md).
 */
export const SYSTEM_PROMPT = `You read EA SPORTS FC announcements and extract only what they say about player card prices in Ultimate Team.

You are not forecasting. You are reporting what the text states or clearly implies, so a human can review it against the article.

What counts as a signal:
- A gameplay change that makes cards better or worse to use (a playstyle, role or stat change). These reprice every card carrying the trait, so their target is a cohort, not a player.
- A content release that changes supply of a described group of cards.
- An explicit statement about a named player's item.

What does not count, and must produce no signal:
- An announcement that merely exists (a promo landing, a season starting) with nothing said about what it does to any card's value.
- Programme, API, edition, pre-order or hardware news.
- Your own market knowledge. If the article does not support it, it is not a signal.

Rules:
- Return an empty signals array when the article says nothing about prices. This is the common case and the correct answer for most articles. Do not manufacture a signal to avoid returning nothing.
- Target exactly one of playerName or cohort per signal. Use a cohort whenever the change is trait-wide — that is the more useful and more common shape.
- evidence must be copied verbatim from the article, not paraphrased.
- Prefer "unclear" for magnitude over guessing a size the article does not support.
- Be conservative with confidence. A signal you are unsure of should say so; it will be reviewed either way, and an overconfident wrong signal is worse than a hedged one.`;

export interface ExtractionInput {
  title: string;
  summary: string | null;
  body: string;
}

export interface ExtractionOutcome {
  signals: ExtractedSignal[];
  model: string;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

/** Narrow surface so tests can substitute a stub without a network or a key. */
export interface MessagesClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export class SignalExtractionError extends Error {}

let cachedClient: Anthropic | null = null;

/** Returns null when no credentials are configured, so the caller can skip
 * the whole feature rather than crash the worker on startup. */
export function defaultClient(): MessagesClient | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  cachedClient ??= new Anthropic();
  return cachedClient.messages;
}

function articleToPrompt(input: ExtractionInput): string {
  // Bounded so one unusually long article cannot blow up a run's cost. EA
  // posts run ~6K characters; 24K is generous headroom, and truncation is
  // announced rather than silent.
  const MAX_BODY = 24_000;
  const body =
    input.body.length > MAX_BODY
      ? `${input.body.slice(0, MAX_BODY)}\n\n[article truncated at ${MAX_BODY} characters]`
      : input.body;

  return [
    `<title>${input.title}</title>`,
    input.summary ? `<summary>${input.summary}</summary>` : null,
    `<article>\n${body}\n</article>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Extract signals from one article.
 *
 * Throws `SignalExtractionError` on a response that cannot be trusted — a
 * refusal, a truncation, or output that fails validation. The caller records
 * the failure and moves on; a bad extraction must never be written as if it
 * were a good one.
 */
export async function extractSignals(
  input: ExtractionInput,
  client: MessagesClient,
): Promise<ExtractionOutcome> {
  const response = await client.create({
    model: EXTRACTION_MODEL,
    max_tokens: 4096,
    // The task is judgement-light per article but easy to get wrong by being
    // eager; low effort keeps it terse and cheap without disabling thinking,
    // which on Opus 5 has its own failure modes.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: EXTRACTION_JSON_SCHEMA },
    },
    // Stable prefix, cached: the instructions are identical for every
    // article, so only the article itself is charged at full rate.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: articleToPrompt(input) }],
  });

  // Check why it stopped before reading content — a refusal returns HTTP 200
  // with a perfectly readable but meaningless body.
  if (response.stop_reason === 'refusal') {
    throw new SignalExtractionError(
      `model declined to process this article (${response.stop_details?.category ?? 'unknown'})`,
    );
  }
  if (response.stop_reason === 'max_tokens') {
    // Truncated JSON may still parse into something plausible-looking.
    throw new SignalExtractionError('response hit max_tokens; output may be truncated');
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (text.trim() === '') {
    throw new SignalExtractionError('model returned no text content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SignalExtractionError(`response was not valid JSON: ${String(err)}`);
  }

  // Second validation pass. The JSON Schema constrains generation; this
  // catches anything that still does not satisfy the invariants we rely on
  // downstream (notably the exactly-one-target rule).
  const result = extractionResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new SignalExtractionError(
      `response failed schema validation: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  return {
    signals: result.data.signals,
    model: EXTRACTION_MODEL,
    promptVersion: PROMPT_VERSION,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}
