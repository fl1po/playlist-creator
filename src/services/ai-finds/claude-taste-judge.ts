import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type {
  JudgePick,
  TasteJudge,
  TasteJudgeOutcome,
  TasteJudgeRequest,
} from '../week-collection/index.js';
import { renderTastePrompt } from './taste-prompt.js';

// The production TasteJudge (ADR-0005): one Claude call per week. SDK types
// and errors stay in this file; the port only ever sees outcomes.

export const MODEL = 'claude-sonnet-5-5';
const EFFORT = 'low';
const MAX_TOKENS = 16_000;

/** Sonnet 5.5, USD per million tokens. The prefix is only ever cached for 1h. */
const PRICE = { input: 2, output: 10, cacheWrite1h: 4, cacheRead: 0.2 };

/** Fewest weeks in a fill for the 1h cache write to pay for itself. */
const CACHE_MIN_WEEKS = 3;

/** Per attempt; the SDK retries 429s and 5xx up to `MAX_RETRIES` times. */
const ATTEMPT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
/**
 * The whole call, retries and their waits included: the SDK honours a
 * `retry-after` of up to an hour, which would stall the fill.
 */
const CALL_DEADLINE_MS = 5 * 60_000;

const PICKS_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Candidate id from the pool' },
          confidence: {
            type: 'integer',
            description:
              '0–100: 85+ clearly wants, 65 probably, 50 coin flip, 30 probably not',
          },
          reason: {
            type: 'string',
            description: 'At most 20 words: why this listener would want it',
          },
        },
        required: ['id', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
} as const;

const picksFormat = jsonSchemaOutputFormat(PICKS_SCHEMA);
/** Unparseable text becomes a null `parsed_output`, so its usage still counts. */
const PICKS_FORMAT: typeof picksFormat = {
  ...picksFormat,
  parse(content) {
    try {
      return picksFormat.parse(content);
    } catch {
      return null as never;
    }
  },
};

export type JudgeParams = Anthropic.MessageCreateParamsNonStreaming;

export interface JudgeResponse {
  stop_reason: Anthropic.StopReason | null;
  usage: Pick<
    Anthropic.Usage,
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_read_input_tokens'
  >;
  parsed_output: unknown;
}

/** The one SDK call the judge makes: `messages.parse`. Tests fake it. */
export interface ClaudeParser {
  parse(
    params: JudgeParams,
    options: { signal: AbortSignal },
  ): Promise<JudgeResponse>;
}

export interface ClaudeTasteJudgeOptions {
  /** The server's Anthropic key. Without one every week is `no-api-key`. */
  apiKey: string | undefined;
  /** Weeks this fill will judge: `CACHE_MIN_WEEKS` or more turns on the 1h cache. */
  fillWeeks: number;
  /** The fill's stop signal: aborts the in-flight request. */
  signal?: AbortSignal;
  /** Defaults to the SDK client built from `apiKey`. */
  client?: ClaudeParser;
  /** Bound on the whole call, retries included. Defaults to `CALL_DEADLINE_MS`. */
  deadlineMs?: number;
}

export function claudeTasteJudge(opts: ClaudeTasteJudgeOptions): TasteJudge {
  const { apiKey, signal } = opts;
  const cache = opts.fillWeeks >= CACHE_MIN_WEEKS;
  let client = opts.client;
  return {
    async judge(request) {
      if (!apiKey) return { ok: false, failure: 'no-api-key', spendUsd: 0 };
      if (!(request.budgetUsd > 0)) {
        return { ok: false, failure: 'over-budget', spendUsd: 0 };
      }
      signal?.throwIfAborted();
      client ??= sdkParser(
        new Anthropic({
          apiKey,
          timeout: ATTEMPT_TIMEOUT_MS,
          maxRetries: MAX_RETRIES,
        }),
      );

      const deadlineMs = opts.deadlineMs ?? CALL_DEADLINE_MS;
      const deadline = AbortSignal.timeout(deadlineMs);
      let response: JudgeResponse;
      try {
        response = await client.parse(judgeParams(request, cache), {
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
      } catch (e) {
        signal?.throwIfAborted();
        if (isSpendCap(e))
          return { ok: false, failure: 'spend-cap', spendUsd: 0 };
        const message = deadline.aborted
          ? `Claude call timed out after ${Math.round(deadlineMs / 1000)}s`
          : e instanceof Error
            ? e.message
            : String(e);
        return failed(message, 0);
      }
      return outcome(response);
    },
  };
}

/** The request for one week; also what the eval script counts tokens on. */
export function judgeParams(
  request: TasteJudgeRequest,
  cache: boolean,
): JudgeParams {
  const prompt = renderTastePrompt(request);
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT, format: PICKS_FORMAT },
    system: [
      {
        type: 'text',
        text: prompt.stable,
        ...(cache && { cache_control: { type: 'ephemeral', ttl: '1h' } }),
      },
    ],
    messages: [{ role: 'user', content: prompt.week }],
  };
}

function outcome(response: JudgeResponse): TasteJudgeOutcome {
  const spendUsd = spendOf(response.usage);
  if (response.stop_reason !== 'end_turn') {
    return failed(
      `Claude stopped early (stop_reason ${response.stop_reason})`,
      spendUsd,
    );
  }
  const picks = picksOf(response.parsed_output);
  if (!picks) return failed('Claude returned no usable picks', spendUsd);
  return { ok: true, picks, spendUsd };
}

function picksOf(output: unknown): JudgePick[] | null {
  const picks = (output as { picks?: unknown } | null)?.picks;
  if (!Array.isArray(picks)) return null;
  const valid = picks.every(
    (p) =>
      typeof p?.id === 'string' &&
      typeof p.confidence === 'number' &&
      typeof p.reason === 'string',
  );
  return valid
    ? picks.map(({ id, confidence, reason }) => ({ id, confidence, reason }))
    : null;
}

function spendOf(usage: JudgeResponse['usage']): number {
  return (
    (usage.input_tokens * PRICE.input +
      usage.output_tokens * PRICE.output +
      (usage.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite1h +
      (usage.cache_read_input_tokens ?? 0) * PRICE.cacheRead) /
    1e6
  );
}

const failed = (message: string, spendUsd: number): TasteJudgeOutcome => ({
  ok: false,
  failure: 'failed',
  message,
  spendUsd,
});

/**
 * Anthropic's monthly spend cap: a 429 that no retry fixes until the month
 * turns. A limit the org set itself is a 400 and stays a plain failure.
 */
function isSpendCap(e: unknown): boolean {
  if (!(e instanceof Anthropic.RateLimitError)) return false;
  const body = e.error as { error?: { details?: { error_code?: string } } };
  return body?.error?.details?.error_code === 'enforced_spend_limit_reached';
}

export function sdkParser(sdk: Anthropic): ClaudeParser {
  return { parse: (params, options) => sdk.messages.parse(params, options) };
}
