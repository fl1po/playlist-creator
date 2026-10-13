import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpotifyAuthLost, TaskAborted } from '../lib/spotify/errors.js';
import type { TrustedArtistsFile } from '../lib/types.js';
import {
  fixedPopularitySource,
  fixtureCandidates,
  fixtureJudge,
  memoryCheckpoints,
} from '../services/week-collection/adapters.js';
import {
  type Candidate,
  type ReleaseReads,
  type TasteJudgeOutcome,
  type WeekCollectionInput,
  type WeekProgressEvent,
  collectWeek,
} from '../services/week-collection/index.js';
import {
  type FixtureAlbum,
  type FixtureArtist,
  fixtureReads,
} from './fixtures/release-catalog.js';

// AI finds, through `collectWeek` with fixture candidate and judge ports.

// ── Helpers ──────────────────────────────────────────────────────────────────

const WEEK = '05.06.26'; // window: 2026-05-30 … 2026-06-05
const IN_WINDOW = '2026-06-05';
const P1 = { priority: 1, score: 100 };
const AI = {
  enabled: true,
  threshold: 50,
  scoutingPlaylists: [],
  budgetUsd: 1,
};

function trusted(
  artistCounts: Record<string, unknown> = {},
): TrustedArtistsFile {
  return { artistCounts } as unknown as TrustedArtistsFile;
}

function input(
  overrides: Partial<WeekCollectionInput> = {},
): WeekCollectionInput {
  return {
    week: WEEK,
    roster: [],
    trustedArtists: trusted(),
    listeningHistory: new Set(),
    editorial: {
      playlists: [],
      externalSources: [],
      gate: { minPopularity: 60, minFollowers: 100_000 },
    },
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    type: 'album',
    trackCount: 1,
    releaseDate: IN_WINDOW,
    genres: [],
    artistFans: 1000,
    upc: `upc-${id}`,
    relativePopularity: null,
    provenance: [{ kind: 'roster', priority: 3 }],
    ...overrides,
  };
}

function pick(id: string, confidence: number, reason = `why ${id}`) {
  return { id, confidence, reason };
}

/** A small artist with one in-window album, `alb-<id>`, barcode `upc-<id>`. */
function smallArtist(
  id: string,
  album: Partial<FixtureAlbum> = {},
): FixtureArtist {
  return {
    id: `art-${id}`,
    name: `Artist ${id}`,
    albums: [
      {
        id: `alb-${id}`,
        name: `Title ${id}`,
        type: 'album',
        release_date: IN_WINDOW,
        upc: `upc-${id}`,
        tracks: [{ id: `${id}-t1`, name: `Song ${id}`, key: `${id}::song` }],
        ...album,
      },
    ],
  };
}

const alpha: FixtureArtist = {
  id: 'art-a',
  name: 'Alpha',
  albums: [
    {
      id: 'alb-x',
      name: 'X',
      type: 'album',
      release_date: IN_WINDOW,
      tracks: [{ id: 't1', name: 'One', key: 'alpha::one' }],
    },
  ],
};

function aiPorts(
  reads: ReleaseReads,
  candidates: Candidate[],
  outcome: TasteJudgeOutcome,
  scores: Record<string, number> = { 'alb-x': 70 },
) {
  const source = fixtureCandidates(candidates);
  const judge = fixtureJudge(outcome);
  return {
    source,
    judge,
    ports: {
      reads,
      popularity: fixedPopularitySource(scores),
      checkpoints: memoryCheckpoints(),
      candidates: source,
      judge,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('absent or disabled AI section runs no phase and leaves no trace', async () => {
  for (const ai of [undefined, { ...AI, enabled: false }]) {
    const reads = fixtureReads({ artists: [alpha, smallArtist('n')] });
    const { source, judge, ports } = aiPorts(reads, [candidate('n')], {
      ok: true,
      picks: [pick('n', 90)],
      spendUsd: 0.05,
    });
    const events: WeekProgressEvent[] = [];

    const week = await collectWeek(
      input({ roster: [['Alpha', P1]], ai }),
      ports,
      (e) => events.push(e),
    );

    assert.deepEqual(week.tracks, ['t1']);
    assert.deepEqual(
      week.decisions.map((d) => d.kind),
      ['release-found'],
    );
    assert.equal(week.aiPicks, undefined);
    assert.equal(week.aiSpendUsd, 0);
    assert.ok(!events.some((e) => e.phase.startsWith('ai-')));
    assert.equal(source.requests.length, 0);
    assert.equal(judge.requests.length, 0);
  }
});

test('P1/P2 artists, already-found releases and out-of-window candidates never reach the judge', async () => {
  const reads = fixtureReads({ artists: [alpha] });
  const { source, judge, ports } = aiPorts(
    reads,
    [
      candidate('p1-artist', { artist: 'ALPHA', title: 'Another' }),
      candidate('same-id', { spotifyAlbumId: 'alb-x', artist: 'Someone' }),
      candidate('same-title', { artist: 'alpha', title: 'x ' }),
      candidate('too-old', { releaseDate: '2026-05-29' }),
      candidate('keeper'),
    ],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(
    input({
      roster: [['Alpha', P1]],
      trustedArtists: trusted({
        Alpha: { priority: 1, score: 100, spotifyId: 'art-a' },
        Lowly: { priority: 3, score: 5, spotifyId: 'art-low' },
      }),
      ai: AI,
    }),
    ports,
  );

  assert.deepEqual(
    judge.requests[0].candidates.map((c) => c.id),
    ['keeper'],
  );
  assert.equal(judge.requests[0].budgetUsd, 1);
  const request = source.requests[0];
  assert.deepEqual(request.seeds, [{ name: 'Alpha', spotifyId: null }]);
  assert.deepEqual(request.rosterArtists, [
    { name: 'Lowly', priority: 3, spotifyId: 'art-low' },
  ]);
  assert.ok(request.window.includes(IN_WINDOW));
});

test('the threshold decides what lands; unknown ids are discarded', async () => {
  const reads = fixtureReads({
    artists: [smallArtist('lo'), smallArtist('at'), smallArtist('hi')],
  });
  const { ports } = aiPorts(
    reads,
    [candidate('lo'), candidate('at'), candidate('hi')],
    {
      ok: true,
      picks: [
        pick('lo', 49),
        pick('at', 50),
        pick('hi', 80),
        pick('ghost', 99),
      ],
      spendUsd: 0.07,
    },
  );

  const week = await collectWeek(input({ ai: AI }), ports);

  assert.deepEqual(week.tracks, ['hi-t1', 'at-t1']);
  assert.deepEqual(
    week.decisions.flatMap((d) => (d.kind === 'ai-pick' ? [d.release] : [])),
    ['Title at', 'Title hi'],
  );
  assert.deepEqual(reads.upcCalls, ['upc-at', 'upc-hi']);
});

test('zero picks above the threshold is a normal outcome', async () => {
  const reads = fixtureReads({ artists: [alpha, smallArtist('n')] });
  const { ports } = aiPorts(reads, [candidate('n')], {
    ok: true,
    picks: [pick('n', 30)],
    spendUsd: 0.06,
  });
  const events: WeekProgressEvent[] = [];

  const week = await collectWeek(
    input({ roster: [['Alpha', P1]], ai: AI }),
    ports,
    (e) => events.push(e),
  );

  assert.deepEqual(week.tracks, ['t1']);
  assert.deepEqual(week.aiPicks, { picks: [] });
  assert.equal(week.aiSpendUsd, 0.06);
  assert.ok(!week.decisions.some((d) => d.kind.startsWith('ai-')));
  assert.deepEqual(
    events.filter((e) => e.phase === 'ai-summary'),
    [{ phase: 'ai-summary', picks: 0, candidates: 1, spendUsd: 0.06 }],
  );
});

test('a pick with a known Spotify album id resolves without a search', async () => {
  const reads = fixtureReads({ artists: [smallArtist('s')] });
  const { ports } = aiPorts(
    reads,
    [candidate('dz-1', { spotifyAlbumId: 'alb-s', upc: null })],
    { ok: true, picks: [pick('dz-1', 70)], spendUsd: 0.05 },
  );

  const week = await collectWeek(input({ ai: AI }), ports);

  assert.deepEqual(week.tracks, ['s-t1']);
  assert.deepEqual(reads.upcCalls, []);
});

test('a pick resolves by barcode and then through the variant choice', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-v',
        name: 'Vee',
        albums: [
          {
            id: 'alb-clean',
            name: 'Twin',
            type: 'album',
            release_date: IN_WINDOW,
            markets: 9,
            explicit: false,
            upc: 'upc-v',
            tracks: [{ id: 'clean-t', name: 'Cut', key: 'vee::cut' }],
          },
          {
            id: 'alb-explicit',
            name: 'Twin',
            type: 'album',
            release_date: IN_WINDOW,
            markets: 2,
            explicit: true,
            tracks: [{ id: 'explicit-t', name: 'Cut', key: 'vee::cut' }],
          },
        ],
      },
    ],
  });
  const { ports } = aiPorts(
    reads,
    [candidate('v', { artist: 'Vee', title: 'Twin', upc: 'upc-v' })],
    { ok: true, picks: [pick('v', 70, 'close to your core')], spendUsd: 0.05 },
  );

  const week = await collectWeek(input({ ai: AI }), ports);

  assert.deepEqual(reads.upcCalls, ['upc-v']);
  assert.deepEqual(week.tracks, ['explicit-t']);
  assert.deepEqual(
    week.decisions.find((d) => d.kind === 'ai-pick'),
    {
      kind: 'ai-pick',
      artist: 'Vee',
      release: 'Twin',
      albumId: 'alb-explicit',
      confidence: 70,
      reason: 'close to your core',
    },
  );
  assert.deepEqual(week.aiPicks, {
    picks: [
      {
        albumId: 'alb-explicit',
        artist: 'Vee',
        title: 'Twin',
        confidence: 70,
        reason: 'close to your core',
      },
    ],
  });
});

test('picks not on Spotify or left with no tracks are skipped with a reason', async () => {
  const reads = fixtureReads({ artists: [smallArtist('heard')] });
  const { ports } = aiPorts(
    reads,
    [
      candidate('deezer-only', { artist: 'Nobody', title: 'Gone' }),
      candidate('heard', { artist: 'Artist heard', title: 'Title heard' }),
    ],
    {
      ok: true,
      picks: [pick('deezer-only', 90), pick('heard', 80)],
      spendUsd: 0.05,
    },
  );
  const events: WeekProgressEvent[] = [];

  const week = await collectWeek(
    input({ ai: AI, listeningHistory: new Set(['heard-t1']) }),
    ports,
    (e) => events.push(e),
  );

  assert.deepEqual(week.tracks, []);
  assert.deepEqual(
    week.decisions.filter((d) => d.kind === 'ai-skipped'),
    [
      {
        kind: 'ai-skipped',
        reason: 'not on Spotify',
        artist: 'Nobody',
        release: 'Gone',
      },
      {
        kind: 'ai-skipped',
        reason: 'no tracks left',
        artist: 'Artist heard',
        release: 'Title heard',
      },
    ],
  );
  assert.equal(events.filter((e) => e.phase === 'ai-skip').length, 2);
  assert.deepEqual(week.aiPicks, { picks: [] });
});

test('picks bypass the popularity gate and play after ranked releases, highest confidence first', async () => {
  const reads = fixtureReads({
    artists: [alpha, smallArtist('mid'), smallArtist('top')],
  });
  const { ports } = aiPorts(
    reads,
    [candidate('mid'), candidate('top')],
    { ok: true, picks: [pick('mid', 60), pick('top', 95)], spendUsd: 0.08 },
    // Both picks would fail the gate (minPopularity 60) if it applied.
    { 'alb-x': 70, 'alb-mid': 1, 'alb-top': 2 },
  );
  const events: WeekProgressEvent[] = [];

  const week = await collectWeek(
    input({ roster: [['Alpha', P1]], ai: AI }),
    ports,
    (e) => events.push(e),
  );

  assert.deepEqual(week.tracks, ['t1', 'top-t1', 'mid-t1']);
  assert.ok(!week.decisions.some((d) => d.kind === 'low-popularity'));
  const top = week.releases.find((r) => r.id === 'alb-top');
  assert.equal(top?.priority, 'ai');
  assert.deepEqual(top?.aiFind, { confidence: 95, reason: 'why top' });
  assert.deepEqual(
    events.filter((e) => e.phase === 'ai-pick' || e.phase === 'ai-summary'),
    [
      {
        phase: 'ai-pick',
        artist: 'Artist mid',
        release: 'Title mid',
        confidence: 60,
        reason: 'why mid',
      },
      {
        phase: 'ai-pick',
        artist: 'Artist top',
        release: 'Title top',
        confidence: 95,
        reason: 'why top',
      },
      { phase: 'ai-summary', picks: 2, candidates: 2, spendUsd: 0.08 },
    ],
  );
  assert.equal(week.aiSpendUsd, 0.08);
});

test('a pick whose Spotify album falls outside the window does not land', async () => {
  const reads = fixtureReads({
    artists: [smallArtist('re', { release_date: '2019-03-01' })],
  });
  const { ports } = aiPorts(reads, [candidate('re')], {
    ok: true,
    picks: [pick('re', 90)],
    spendUsd: 0.05,
  });

  const week = await collectWeek(input({ ai: AI }), ports);

  assert.deepEqual(week.tracks, []);
  assert.deepEqual(
    week.decisions.filter((d) => d.kind === 'ai-skipped'),
    [
      {
        kind: 'ai-skipped',
        reason: 'not on Spotify',
        artist: 'Artist re',
        release: 'Title re',
      },
    ],
  );
});

// ── Failures and budget (never fatal) ────────────────────────────────────────

function throwingCandidates(error: Error) {
  return {
    requests: [],
    async candidates(): Promise<Candidate[]> {
      throw error;
    },
  };
}

function throwingJudge(error: Error) {
  return {
    requests: [],
    async judge(): Promise<TasteJudgeOutcome> {
      throw error;
    },
  };
}

test("each judge failure skips the week's AI finds and leaves the rest of the week intact", async () => {
  const failures: Array<{
    outcome: TasteJudgeOutcome;
    message?: string;
  }> = [
    { outcome: { ok: false, failure: 'no-api-key', spendUsd: 0 } },
    { outcome: { ok: false, failure: 'over-budget', spendUsd: 0 } },
    {
      outcome: {
        ok: false,
        failure: 'failed',
        message: 'truncated',
        spendUsd: 0.03,
      },
      message: 'truncated',
    },
  ];
  for (const { outcome, message } of failures) {
    const reads = fixtureReads({ artists: [alpha, smallArtist('n')] });
    const { ports } = aiPorts(reads, [candidate('n')], outcome);
    const events: WeekProgressEvent[] = [];

    const week = await collectWeek(
      input({ roster: [['Alpha', P1]], ai: AI }),
      ports,
      (e) => events.push(e),
    );

    const reason = outcome.ok ? undefined : outcome.failure;
    assert.deepEqual(week.tracks, ['t1']);
    assert.deepEqual(
      week.releases.map((r) => r.id),
      ['alb-x'],
    );
    assert.deepEqual(
      week.decisions.filter((d) => d.kind.startsWith('ai-')),
      [{ kind: 'ai-skipped', reason }],
    );
    assert.deepEqual(week.aiPicks, { skipped: reason });
    assert.deepEqual(
      events.filter((e) => e.phase === 'ai-skip'),
      [{ phase: 'ai-skip', reason, message }],
    );
    assert.equal(week.aiSpendUsd, outcome.spendUsd);
    assert.equal(week.aiExhausted, false);
  }
});

test('the spend cap skips the week as failed and exhausts AI finds', async () => {
  const reads = fixtureReads({ artists: [alpha, smallArtist('n')] });
  const { ports } = aiPorts(reads, [candidate('n')], {
    ok: false,
    failure: 'spend-cap',
    spendUsd: 0.02,
  });

  const week = await collectWeek(
    input({ roster: [['Alpha', P1]], ai: AI }),
    ports,
  );

  assert.deepEqual(week.tracks, ['t1']);
  assert.deepEqual(
    week.releases.map((r) => r.id),
    ['alb-x'],
  );
  assert.deepEqual(
    week.decisions.filter((d) => d.kind.startsWith('ai-')),
    [{ kind: 'ai-skipped', reason: 'failed' }],
  );
  assert.deepEqual(week.aiPicks, { skipped: 'failed' });
  assert.equal(week.aiExhausted, true);
  assert.equal(week.aiSpendUsd, 0.02);
});

test("a landed week is not exhausted and reports the judge's spend", async () => {
  const reads = fixtureReads({ artists: [smallArtist('n')] });
  const { judge, ports } = aiPorts(reads, [candidate('n')], {
    ok: true,
    picks: [pick('n', 90)],
    spendUsd: 0.07,
  });

  const week = await collectWeek(
    input({ ai: { ...AI, budgetUsd: 0.4 } }),
    ports,
  );

  assert.deepEqual(week.tracks, ['n-t1']);
  assert.equal(week.aiSpendUsd, 0.07);
  assert.equal(week.aiExhausted, false);
  assert.equal(judge.requests[0]?.budgetUsd, 0.4);
});

test('with no budget left or none passed, the week is over budget without a judge call', async () => {
  for (const budgetUsd of [0, -0.01, undefined]) {
    const reads = fixtureReads({ artists: [alpha, smallArtist('n')] });
    const { source, judge, ports } = aiPorts(reads, [candidate('n')], {
      ok: true,
      picks: [pick('n', 90)],
      spendUsd: 0.05,
    });

    const week = await collectWeek(
      input({ roster: [['Alpha', P1]], ai: { ...AI, budgetUsd } }),
      ports,
    );

    assert.equal(judge.requests.length, 0);
    assert.equal(source.requests.length, 0);
    assert.deepEqual(week.tracks, ['t1']);
    assert.deepEqual(week.aiPicks, { skipped: 'over-budget' });
    assert.deepEqual(
      week.decisions.filter((d) => d.kind === 'ai-skipped'),
      [{ kind: 'ai-skipped', reason: 'over-budget' }],
    );
    assert.equal(week.aiSpendUsd, 0);
  }
});

test('a throwing judge is recorded as failed with its message', async () => {
  const reads = fixtureReads({ artists: [alpha] });
  const { ports } = aiPorts(reads, [candidate('n')], {
    ok: true,
    picks: [],
    spendUsd: 0,
  });
  ports.judge = throwingJudge(new Error('socket hang up'));
  const events: WeekProgressEvent[] = [];

  const week = await collectWeek(
    input({ roster: [['Alpha', P1]], ai: AI }),
    ports,
    (e) => events.push(e),
  );

  assert.deepEqual(week.tracks, ['t1']);
  assert.deepEqual(week.aiPicks, { skipped: 'failed' });
  assert.deepEqual(
    events.filter((e) => e.phase === 'ai-skip'),
    [{ phase: 'ai-skip', reason: 'failed', message: 'socket hang up' }],
  );
});

test('a throwing candidate source degrades the pool instead of failing the week', async () => {
  const reads = fixtureReads({ artists: [alpha] });
  const { judge, ports } = aiPorts(reads, [], {
    ok: true,
    picks: [],
    spendUsd: 0.01,
  });
  ports.candidates = throwingCandidates(new Error('Deezer 503'));

  const week = await collectWeek(
    input({ roster: [['Alpha', P1]], ai: AI }),
    ports,
  );

  assert.deepEqual(week.tracks, ['t1']);
  assert.deepEqual(judge.requests[0]?.candidates, []);
  assert.deepEqual(week.aiPicks, { picks: [] });
});

test('a pick whose resolution throws is skipped as failed; other picks still land', async () => {
  const reads = fixtureReads({
    artists: [smallArtist('bad'), smallArtist('ok')],
  });
  const searchByUpc = reads.searchByUpc.bind(reads);
  reads.searchByUpc = async (upc) => {
    if (upc === 'upc-bad') throw new Error('Spotify 500');
    return searchByUpc(upc);
  };
  const { ports } = aiPorts(reads, [candidate('bad'), candidate('ok')], {
    ok: true,
    picks: [pick('bad', 90), pick('ok', 80)],
    spendUsd: 0.05,
  });

  const week = await collectWeek(input({ ai: AI }), ports);

  assert.deepEqual(week.tracks, ['ok-t1']);
  assert.deepEqual(
    week.decisions.filter((d) => d.kind === 'ai-skipped'),
    [
      {
        kind: 'ai-skipped',
        reason: 'failed',
        artist: 'Artist bad',
        release: 'Title bad',
      },
    ],
  );
});

test('abort and Spotify auth loss anywhere in the AI phase propagate', async () => {
  const escapes = [new TaskAborted(), new SpotifyAuthLost('gone')];
  for (const error of escapes) {
    const raise = async (): Promise<never> => {
      throw error;
    };
    const where = {
      candidates: (p: ReturnType<typeof aiPorts>['ports']) => {
        p.candidates = throwingCandidates(error);
      },
      judge: (p: ReturnType<typeof aiPorts>['ports']) => {
        p.judge = throwingJudge(error);
      },
      resolution: (p: ReturnType<typeof aiPorts>['ports']) => {
        p.reads.searchByUpc = raise;
      },
      tracks: (p: ReturnType<typeof aiPorts>['ports']) => {
        const albumTracks = p.reads.albumTracks.bind(p.reads);
        p.reads.albumTracks = (id) =>
          id === 'alb-n' ? raise() : albumTracks(id);
      },
    };
    for (const [at, breakPorts] of Object.entries(where)) {
      const reads = fixtureReads({ artists: [alpha, smallArtist('n')] });
      const { ports } = aiPorts(reads, [candidate('n')], {
        ok: true,
        picks: [pick('n', 90)],
        spendUsd: 0.05,
      });
      breakPorts(ports);

      await assert.rejects(
        collectWeek(input({ roster: [['Alpha', P1]], ai: AI }), ports),
        (e) => e === error,
        `${error.name} from ${at}`,
      );
    }
  }
});

test("a pick whose tracks can't be fetched is skipped as failed; the week completes", async () => {
  const reads = fixtureReads({ artists: [alpha, smallArtist('bad')] });
  const albumTracks = reads.albumTracks.bind(reads);
  reads.albumTracks = async (albumId) => {
    if (albumId === 'alb-bad') throw new Error('Spotify 500');
    return albumTracks(albumId);
  };
  const { ports } = aiPorts(reads, [candidate('bad')], {
    ok: true,
    picks: [pick('bad', 90)],
    spendUsd: 0.05,
  });
  const events: WeekProgressEvent[] = [];

  const week = await collectWeek(
    input({ roster: [['Alpha', P1]], ai: AI }),
    ports,
    (e) => events.push(e),
  );

  assert.deepEqual(week.tracks, ['t1']);
  assert.deepEqual(week.aiPicks, { picks: [] });
  assert.deepEqual(
    week.decisions.filter((d) => d.kind === 'ai-skipped'),
    [
      {
        kind: 'ai-skipped',
        reason: 'failed',
        artist: 'Artist bad',
        release: 'Title bad',
      },
    ],
  );
  assert.deepEqual(
    events.filter((e) => e.phase === 'ai-skip'),
    [
      {
        phase: 'ai-skip',
        reason: 'failed',
        artist: 'Artist bad',
        release: 'Title bad',
        message: 'Spotify 500',
      },
    ],
  );
});
