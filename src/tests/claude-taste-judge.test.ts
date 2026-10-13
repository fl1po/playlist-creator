import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { TaskAborted } from '../lib/spotify/errors.js';
import {
  type ClaudeParser,
  claudeTasteJudge,
  type JudgeResponse,
} from '../services/ai-finds/claude-taste-judge.js';
import type {
  Candidate,
  TasteJudgeRequest,
} from '../services/week-collection/index.js';

// The Claude TasteJudge over a fake `messages.parse`. No assertions on prompt
// text: the prompt is tuned against the eval script, not pinned here.

// ── Helpers ──────────────────────────────────────────────────────────────────

const CANDIDATE: Candidate = {
  id: 'c1',
  title: 'Night Bus',
  artist: 'Nova',
  type: 'single',
  trackCount: 1,
  releaseDate: '2026-06-05',
  genres: ['Rap/Hip Hop'],
  artistFans: 1200,
  upc: null,
  relativePopularity: 0.8,
  provenance: [
    { kind: 'related', to: ['Seed A', 'Seed B'] },
    { kind: 'editorial-reject', reason: 'popularity 6', playlists: ['Fresh'] },
  ],
};

function request(over: Partial<TasteJudgeRequest> = {}): TasteJudgeRequest {
  return {
    taste: {
      roster: [
        { name: 'Seed A', tier: 'P1' },
        { name: 'Lower', tier: 'P3' },
      ],
      weekReleases: [{ artist: 'Seed A', release: 'Big Album' }],
      acceptGenres: ['hip hop'],
    },
    candidates: [CANDIDATE],
    budgetUsd: 1,
    ...over,
  };
}

const USAGE = {
  input_tokens: 10_000,
  output_tokens: 1_000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function response(over: Partial<JudgeResponse> = {}): JudgeResponse {
  return {
    stop_reason: 'end_turn',
    usage: USAGE,
    parsed_output: {
      picks: [{ id: 'c1', confidence: 72, reason: 'Sits beside Seed A' }],
    },
    ...over,
  };
}

/** A fake parser: answers with `reply` (or what it computes), records calls. */
function fakeParser(
  reply: JudgeResponse | ((signal: AbortSignal) => Promise<JudgeResponse>),
): ClaudeParser & {
  calls: Array<{
    params: Parameters<ClaudeParser['parse']>[0];
    signal: AbortSignal;
  }>;
} {
  return {
    calls: [],
    async parse(params, { signal }) {
      this.calls.push({ params, signal });
      return typeof reply === 'function' ? reply(signal) : reply;
    },
  };
}

function judge(
  parser: ClaudeParser,
  over: Partial<Parameters<typeof claudeTasteJudge>[0]> = {},
) {
  return claudeTasteJudge({
    apiKey: 'sk-test',
    fillWeeks: 1,
    client: parser,
    ...over,
  });
}

function rateLimit(body: object) {
  return new Anthropic.RateLimitError(
    429,
    {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'x', ...body },
    },
    'rate limited',
    new Headers(),
  );
}

/** Settles once `signal` aborts, rejecting the way the SDK does. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () =>
      reject(new Anthropic.APIUserAbortError()),
    );
  });
}

// ── Calls it doesn't make ────────────────────────────────────────────────────

test('without a key, the judge is no-api-key and makes no call', async () => {
  const parser = fakeParser(response());
  const outcome = await judge(parser, { apiKey: undefined }).judge(request());
  assert.deepEqual(outcome, { ok: false, failure: 'no-api-key', spendUsd: 0 });
  assert.equal(parser.calls.length, 0);
});

test('without budget, the judge is over-budget and makes no call', async () => {
  const parser = fakeParser(response());
  const outcome = await judge(parser).judge(request({ budgetUsd: 0 }));
  assert.deepEqual(outcome, { ok: false, failure: 'over-budget', spendUsd: 0 });
  assert.equal(parser.calls.length, 0);
});

// ── Success ──────────────────────────────────────────────────────────────────

test('picks come back with the spend their usage cost', async () => {
  const parser = fakeParser(response());
  const outcome = await judge(parser).judge(request());
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.picks, [
    { id: 'c1', confidence: 72, reason: 'Sits beside Seed A' },
  ]);
  // 10K in at $2, 1K out at $10 per MTok.
  assert.equal(outcome.spendUsd.toFixed(4), '0.0300');
});

test('cache writes and reads count toward spend', async () => {
  const parser = fakeParser(
    response({
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      },
    }),
  );
  const outcome = await judge(parser, { fillWeeks: 3 }).judge(request());
  assert.ok(outcome.ok);
  // 1h cache write $4, cache read $0.20 per MTok.
  assert.equal(outcome.spendUsd.toFixed(2), '4.20');
});

test('one call per judgement, on Sonnet 5.5 at low effort', async () => {
  const parser = fakeParser(response());
  await judge(parser).judge(request());
  assert.equal(parser.calls.length, 1);
  const { params } = parser.calls[0];
  assert.equal(params.model, 'claude-sonnet-5-5');
  assert.equal(params.output_config?.effort, 'low');
  assert.equal(params.output_config?.format?.type, 'json_schema');
});

// ── Caching ──────────────────────────────────────────────────────────────────

function cacheControls(params: Parameters<ClaudeParser['parse']>[0]) {
  const blocks = [
    ...(Array.isArray(params.system) ? params.system : []),
    ...params.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    ),
  ];
  return blocks.flatMap((b) =>
    'cache_control' in b && b.cache_control ? [b.cache_control] : [],
  );
}

test('a fill of 3+ weeks caches the stable prefix for an hour', async () => {
  const parser = fakeParser(response());
  await judge(parser, { fillWeeks: 3 }).judge(request());
  const { params } = parser.calls[0];
  assert.deepEqual(cacheControls(params), [{ type: 'ephemeral', ttl: '1h' }]);
  assert.equal(params.cache_control, undefined);
});

test('a fill of fewer than 3 weeks caches nothing', async () => {
  const parser = fakeParser(response());
  await judge(parser, { fillWeeks: 2 }).judge(request());
  const { params } = parser.calls[0];
  assert.deepEqual(cacheControls(params), []);
  assert.equal(params.cache_control, undefined);
});

// ── Failures ─────────────────────────────────────────────────────────────────

for (const stop_reason of ['max_tokens', 'refusal', 'pause_turn'] as const) {
  test(`stop_reason ${stop_reason} fails, still charging its usage`, async () => {
    const parser = fakeParser(response({ stop_reason, parsed_output: null }));
    const outcome = await judge(parser).judge(request());
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.failure === 'failed');
    assert.match(outcome.message, new RegExp(stop_reason));
    assert.equal(outcome.spendUsd.toFixed(4), '0.0300');
  });
}

test('unparseable output fails, still charging its usage', async () => {
  const parser = fakeParser(response({ parsed_output: null }));
  const outcome = await judge(parser).judge(request());
  assert.ok(!outcome.ok && outcome.failure === 'failed');
  assert.ok(outcome.message.length > 0);
  assert.equal(outcome.spendUsd.toFixed(4), '0.0300');
});

test('output not in the picks shape fails', async () => {
  const parser = fakeParser(
    response({ parsed_output: { picks: 'none' } as never }),
  );
  const outcome = await judge(parser).judge(request());
  assert.ok(!outcome.ok && outcome.failure === 'failed');
});

test('an SDK API error fails with its message and no spend', async () => {
  const parser = fakeParser(async () => {
    throw new Anthropic.InternalServerError(
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
      'Overloaded',
      new Headers(),
    );
  });
  const outcome = await judge(parser).judge(request());
  assert.ok(!outcome.ok && outcome.failure === 'failed');
  assert.match(outcome.message, /529/);
  assert.equal(outcome.spendUsd, 0);
});

test('a plain error (e.g. unresolved credentials) fails', async () => {
  const parser = fakeParser(async () => {
    throw new Error('Could not resolve authentication method');
  });
  const outcome = await judge(parser).judge(request());
  assert.ok(!outcome.ok && outcome.failure === 'failed');
  assert.match(outcome.message, /authentication/);
});

test('an ordinary rate limit fails', async () => {
  const parser = fakeParser(async () => {
    throw rateLimit({});
  });
  const outcome = await judge(parser).judge(request());
  assert.ok(!outcome.ok && outcome.failure === 'failed');
});

test("Anthropic's spend-cap 429 is spend-cap", async () => {
  const parser = fakeParser(async () => {
    throw rateLimit({
      details: { error_code: 'enforced_spend_limit_reached' },
    });
  });
  const outcome = await judge(parser).judge(request());
  assert.deepEqual(outcome, { ok: false, failure: 'spend-cap', spendUsd: 0 });
});

test('a call that outlasts the deadline (e.g. a long retry-after) fails', async () => {
  const parser = fakeParser(untilAborted);
  const outcome = await judge(parser, { deadlineMs: 5 }).judge(request());
  assert.ok(!outcome.ok && outcome.failure === 'failed');
  assert.match(outcome.message, /timed out/);
  assert.ok(parser.calls[0].signal.aborted);
});

// ── Abort ────────────────────────────────────────────────────────────────────

test("stopping the fill cancels the request and propagates the fill's abort", async () => {
  const stop = new AbortController();
  const parser = fakeParser(untilAborted);
  const pending = judge(parser, { signal: stop.signal }).judge(request());
  await new Promise((r) => setImmediate(r));
  stop.abort(new TaskAborted());
  await assert.rejects(pending, TaskAborted);
  assert.ok(parser.calls[0].signal.aborted);
});

test('an already-stopped fill makes no call', async () => {
  const stop = new AbortController();
  stop.abort(new TaskAborted());
  const parser = fakeParser(response());
  await assert.rejects(
    judge(parser, { signal: stop.signal }).judge(request()),
    TaskAborted,
  );
  assert.equal(parser.calls.length, 0);
});
