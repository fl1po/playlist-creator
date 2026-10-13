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
  collectWeek,
  type ReleaseReads,
  type TasteJudgeOutcome,
  type WeekCollectionInput,
  type WeekProgressEvent,
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
  hasApiKey: true,
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

test('with no budget left, the week is over budget without a judge call', async () => {
  for (const budgetUsd of [0, -0.01]) {
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

test('with no server key, the week is no-api-key without a pool or judge call', async () => {
  const reads = fixtureReads({ artists: [alpha, smallArtist('n')] });
  const { source, judge, ports } = aiPorts(reads, [candidate('n')], {
    ok: true,
    picks: [pick('n', 90)],
    spendUsd: 0.05,
  });

  const week = await collectWeek(
    input({ roster: [['Alpha', P1]], ai: { ...AI, hasApiKey: false } }),
    ports,
  );

  assert.equal(judge.requests.length, 0);
  assert.equal(source.requests.length, 0);
  assert.deepEqual(week.tracks, ['t1']);
  assert.deepEqual(week.aiPicks, { skipped: 'no-api-key' });
  assert.deepEqual(
    week.decisions.filter((d) => d.kind === 'ai-skipped'),
    [{ kind: 'ai-skipped', reason: 'no-api-key' }],
  );
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

// ── Pool rules and taste context ─────────────────────────────────────────────

const judgeIds = (judge: ReturnType<typeof fixtureJudge>) =>
  judge.requests[0].candidates.map((c) => c.id);

/** An artist the editorial gate looks at, with one in-window album. */
function editorialArtist(id: string, name: string): FixtureArtist {
  return {
    id: `art-${id}`,
    name,
    albums: [
      {
        id: `alb-${id}`,
        name: `${name} Album`,
        type: 'album',
        release_date: IN_WINDOW,
        tracks: [{ id: `${id}-t1`, name: 'Song', key: `${id}::song` }],
      },
    ],
  };
}

test('editorial and low-popularity rejects reach the judge with their gate reason and playlists', async () => {
  const profile = (popularity: number, genres: string[]) => ({
    popularity,
    followers: 1000,
    genres,
  });
  const reads = fixtureReads({
    artists: [
      editorialArtist('small', 'Small'),
      editorialArtist('off', 'Offgenre'),
      editorialArtist('banned', 'Banned'),
      editorialArtist('big', 'Big'),
      editorialArtist('weak', 'Weak'),
    ],
    playlistAlbums: {
      'pl-ff': ['alb-small', 'alb-off', 'alb-banned', 'alb-big'],
      'pl-nmf': ['alb-small', 'alb-weak', 'alb-big'],
    },
    profiles: {
      'art-small': profile(6, ['pop']),
      'art-off': profile(80, ['ambient']),
      'art-banned': profile(80, ['metal']),
      'art-big': profile(80, ['pop']),
      'art-weak': profile(80, ['pop']),
    },
  });
  const { judge, ports } = aiPorts(
    reads,
    // Deezer also has the admitted editorial find: it never reaches the judge.
    [candidate('dz-big', { artist: 'Big', title: 'Big Album', upc: null })],
    { ok: true, picks: [], spendUsd: 0.01 },
    { 'alb-big': 70, 'alb-weak': 5 },
  );

  const week = await collectWeek(
    input({
      editorial: {
        playlists: [
          { id: 'pl-ff', name: 'Fresh Finds' },
          { id: 'pl-nmf', name: 'NMF' },
        ],
        externalSources: [],
        gate: { minPopularity: 60, minFollowers: 100_000 },
      },
      ai: AI,
    }),
    ports,
  );

  assert.deepEqual(
    Object.fromEntries(
      judge.requests[0].candidates.map((c) => [
        c.id,
        [c.spotifyAlbumId, c.provenance],
      ]),
    ),
    {
      'reject-alb-small': [
        'alb-small',
        [
          {
            kind: 'editorial-reject',
            reason: 'popularity 6',
            playlists: ['Fresh Finds', 'NMF'],
          },
        ],
      ],
      'reject-alb-off': [
        'alb-off',
        [
          {
            kind: 'editorial-reject',
            reason: 'no accepted genre',
            playlists: ['Fresh Finds'],
          },
        ],
      ],
      'reject-alb-weak': [
        'alb-weak',
        [{ kind: 'low-popularity', popularity: 5, playlists: ['NMF'] }],
      ],
    },
  );
  assert.deepEqual(
    week.decisions.find((d) => d.kind === 'low-popularity'),
    {
      kind: 'low-popularity',
      artist: 'Weak',
      release: 'Weak Album',
      albumId: 'alb-weak',
      popularity: 5,
    },
  );
});

test('the same release from two sources is one candidate listing both', async () => {
  const reads = fixtureReads({ artists: [] });
  const related = { kind: 'related' as const, to: ['Alpha'] };
  const { judge, ports } = aiPorts(
    reads,
    [
      candidate('dz-a', { upc: 'U1', provenance: [related] }),
      candidate('sp-a', {
        upc: 'U1',
        title: 'Title dz-a (Deluxe)',
        provenance: [{ kind: 'scouting', playlist: 'Lorem' }],
        spotifyAlbumId: 'alb-a',
      }),
      candidate('dz-b', {
        artist: 'Beyoncé',
        title: 'Song (feat. Jay-Z)',
        upc: 'U2',
        relativePopularity: null,
        provenance: [related],
      }),
      candidate('rs-b', {
        artist: 'beyonce',
        title: 'Song',
        upc: null,
        relativePopularity: 0.8,
        provenance: [{ kind: 'roster', priority: 3 }],
      }),
    ],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(input({ ai: AI }), ports);

  const pool = judge.requests[0].candidates;
  assert.deepEqual(
    pool.map((c) => [c.id, c.provenance, c.spotifyAlbumId]),
    [
      ['dz-a', [related, { kind: 'scouting', playlist: 'Lorem' }], 'alb-a'],
      ['dz-b', [related, { kind: 'roster', priority: 3 }], undefined],
    ],
  );
  assert.equal(pool[1].relativePopularity, 0.8);
});

test('candidates in a rejected genre never reach the judge', async () => {
  const cases = [
    { genreFilters: undefined, vetoed: 'metal' },
    {
      genreFilters: { accepted: ['pop'], rejected: ['drill'] },
      vetoed: 'drill',
    },
  ];
  for (const { genreFilters, vetoed } of cases) {
    const reads = fixtureReads({ artists: [] });
    const { judge, ports } = aiPorts(
      reads,
      [
        candidate('metal', { genres: ['Death Metal'] }),
        candidate('drill', { genres: ['UK Drill'] }),
        candidate('pop', { genres: ['Pop'] }),
        candidate('none', { genres: [] }),
      ],
      { ok: true, picks: [], spendUsd: 0.01 },
    );

    await collectWeek(
      input({
        editorial: { ...input().editorial, genreFilters },
        ai: AI,
      }),
      ports,
    );

    assert.deepEqual(
      judgeIds(judge),
      ['metal', 'drill', 'pop', 'none'].filter((id) => id !== vetoed),
    );
  }
});

test('variants collapse so each release is judged once', async () => {
  const reads = fixtureReads({ artists: [] });
  const by = (artist: string, title: string) => ({ artist, title });
  const { judge, ports } = aiPorts(
    reads,
    [
      candidate('night-sped', by('Vee', 'Night (Sped Up)')),
      candidate('night', by('Vee', 'Night')),
      candidate('night-inst', by('Vee', 'Night (Instrumental)')),
      candidate('night-clean', by('Vee', 'Night - Clean')),
      candidate('day-inst', by('Vee', 'Day (Instrumental)')),
      candidate('moon-slowed', by('Vee', 'Moon (Slowed + Reverb)')),
      candidate('other-inst', by('Dub', 'Night (Instrumental)')),
    ],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(input({ ai: AI }), ports);

  assert.deepEqual(judgeIds(judge), ['night', 'day-inst', 'other-inst']);
  // Night's variants all came from the roster: still one source.
  assert.deepEqual(judge.requests[0].candidates[0].provenance, [
    { kind: 'roster', priority: 3 },
  ]);
});

test('a candidate dated only by month counts as in window like an editorial release', async () => {
  const reads = fixtureReads({ artists: [] });
  const { judge, ports } = aiPorts(
    reads,
    [
      candidate('may', { releaseDate: '2026-05' }), // May 31 is in the window
      candidate('june', { releaseDate: '2026-06' }),
    ],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(input({ ai: AI }), ports);

  assert.deepEqual(judgeIds(judge), ['may']);
});

function many(
  prefix: string,
  count: number,
  overrides: (i: number) => Partial<Candidate>,
): Candidate[] {
  return Array.from({ length: count }, (_, i) =>
    candidate(`${prefix}-${i}`, overrides(i)),
  );
}

test('a pool over 500 is cut: scouting exempt, multi-source next, then relative popularity', async () => {
  const scouting = { kind: 'scouting' as const, playlist: 'Lorem' };
  const roster = { kind: 'roster' as const, priority: 3 };
  const related = { kind: 'related' as const, to: ['Alpha'] };
  // 5 multi-source + 300 high + 100 missing + 115 low = 520 capped, plus 3
  // scouting: the 20 lowest ratios go.
  const reads = fixtureReads({ artists: [] });
  const { judge, ports } = aiPorts(
    reads,
    [
      ...many('lo', 115, (i) => ({ relativePopularity: i / 1000 })),
      ...many('sc', 3, () => ({
        relativePopularity: 0,
        provenance: [scouting],
      })),
      ...many('multi', 5, () => ({
        relativePopularity: 0.001,
        provenance: [related, roster],
      })),
      ...many('none', 100, () => ({ relativePopularity: null })),
      ...many('hi', 300, (i) => ({ relativePopularity: 0.6 + i / 1000 })),
    ],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(input({ ai: AI }), ports);

  const kept = new Set(judgeIds(judge));
  assert.equal(kept.size, 503);
  for (const id of ['sc-0', 'sc-1', 'sc-2', 'multi-0', 'multi-4', 'none-99']) {
    assert.ok(kept.has(id), id);
  }
  assert.deepEqual(
    Array.from({ length: 115 }, (_, i) => `lo-${i}`).filter(
      (id) => !kept.has(id),
    ),
    Array.from({ length: 20 }, (_, i) => `lo-${i}`),
  );
});

test('missing relative popularity is cut after ratios of 0.6 and up, before lower ones', async () => {
  const reads = fixtureReads({ artists: [] });
  const { judge, ports } = aiPorts(
    reads,
    [
      ...many('lo', 10, () => ({ relativePopularity: 0.59 })),
      ...many('none', 250, () => ({ relativePopularity: null })),
      ...many('hi', 300, () => ({ relativePopularity: 0.6 })),
    ],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(input({ ai: AI }), ports);

  const ids = judgeIds(judge);
  assert.equal(ids.length, 500);
  assert.equal(ids.filter((id) => id.startsWith('hi-')).length, 300);
  assert.equal(ids.filter((id) => id.startsWith('none-')).length, 200);
});

test('a pool of 500 non-scouting candidates is not cut', async () => {
  const reads = fixtureReads({ artists: [] });
  const { judge, ports } = aiPorts(
    reads,
    [
      ...many('c', 500, () => ({ relativePopularity: 0.01 })),
      candidate('sc', { provenance: [{ kind: 'scouting', playlist: 'L' }] }),
    ],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(input({ ai: AI }), ports);

  assert.equal(judgeIds(judge).length, 501);
});

test('the taste context holds P1/P2, the top 5% of the rest, the week and the accept list', async () => {
  const artist = (priority: number | null, score: number) => ({
    priority,
    score,
    spotifyId: null,
  });
  // 40 artists: the slice below P1/P2 is the top 2 by score.
  const counts: Record<string, unknown> = {
    Alpha: artist(1, 100),
    Beta: artist(2, 90),
    Gamma: artist(3, 50),
    Delta: artist(4, 40),
    Epsilon: artist(null, 45),
  };
  for (let i = 0; i < 35; i++) counts[`Filler ${i}`] = artist(4, i);
  const reads = fixtureReads({
    artists: [alpha, editorialArtist('ed', 'Newcomer')],
    playlistAlbums: { 'pl-ff': ['alb-ed'] },
    profiles: {
      'art-ed': { popularity: 80, followers: 1000, genres: ['pop'] },
    },
  });
  const { judge, ports } = aiPorts(
    reads,
    [],
    { ok: true, picks: [], spendUsd: 0.01 },
    { 'alb-x': 70, 'alb-ed': 70 },
  );

  await collectWeek(
    input({
      roster: [
        ['Alpha', P1],
        ['Beta', { priority: 2, score: 90 }],
      ],
      trustedArtists: trusted(counts),
      editorial: {
        playlists: [{ id: 'pl-ff', name: 'Fresh Finds' }],
        externalSources: [],
        gate: { minPopularity: 60, minFollowers: 100_000 },
        genreFilters: { accepted: ['pop', 'house'], rejected: ['metal'] },
      },
      ai: AI,
    }),
    ports,
  );

  assert.deepEqual(judge.requests[0].taste, {
    roster: [
      { name: 'Alpha', tier: 'P1' },
      { name: 'Beta', tier: 'P2' },
      { name: 'Gamma', tier: 'P3' },
      { name: 'Epsilon', tier: 'unranked' },
    ],
    weekReleases: [{ artist: 'Alpha', release: 'X' }],
    acceptGenres: ['pop', 'house'],
  });
});

test('the taste slice is capped at 300 artists; the accept list defaults', async () => {
  const counts: Record<string, unknown> = {};
  for (let i = 0; i < 10_000; i++) {
    counts[`Artist ${i}`] = { priority: 4, score: i, spotifyId: null };
  }
  const reads = fixtureReads({ artists: [] });
  const { judge, ports } = aiPorts(reads, [], {
    ok: true,
    picks: [],
    spendUsd: 0.01,
  });

  await collectWeek(input({ trustedArtists: trusted(counts), ai: AI }), ports);

  const { roster, acceptGenres } = judge.requests[0].taste;
  assert.equal(roster.length, 300);
  assert.deepEqual(roster[0], { name: 'Artist 9999', tier: 'P4' });
  assert.ok(acceptGenres.includes('hip-hop'));
});

// ── Scouting playlists ───────────────────────────────────────────────────────

const LOREM = { id: 'pl-lorem', name: 'Lorem' };
const IPSUM = { id: 'pl-ipsum', name: 'Ipsum' };
const scoutingAi = { ...AI, scoutingPlaylists: [LOREM, IPSUM] };
const profileWith = (genres: string[]) => ({
  popularity: 5,
  followers: 10,
  genres,
});

test('scouting playlists are read only when AI finds are on', async () => {
  for (const [ai, read] of [
    [undefined, false],
    [{ ...scoutingAi, enabled: false }, false],
    [scoutingAi, true],
  ] as const) {
    const reads = fixtureReads({
      artists: [smallArtist('sc')],
      playlistAlbums: { 'pl-lorem': ['alb-sc'] },
    });
    const { ports } = aiPorts(reads, [], {
      ok: true,
      picks: [],
      spendUsd: 0.01,
    });

    await collectWeek(input({ ai }), ports);

    assert.equal(reads.playlistCalls.includes('pl-lorem'), read);
  }
});

test('in-window scouting releases by non-P1/P2 artists reach the judge with their playlists', async () => {
  const reads = fixtureReads({
    artists: [
      alpha,
      smallArtist('sc'),
      smallArtist('old', { release_date: '2026-05-01' }),
      editorialArtist('ed', 'Edith'),
    ],
    playlistAlbums: {
      'pl-ff': ['alb-ed'],
      // Found by the search, too old, admitted from editorial: all skipped.
      'pl-lorem': ['alb-x', 'alb-sc', 'alb-old', 'alb-ed'],
      'pl-ipsum': ['alb-sc'],
    },
    profiles: {
      'art-ed': { popularity: 80, followers: 1000, genres: ['pop'] },
      'art-sc': profileWith(['pop']),
    },
  });
  const { source, judge, ports } = aiPorts(
    reads,
    [],
    { ok: true, picks: [], spendUsd: 0.01 },
    { 'alb-x': 70, 'alb-ed': 70 },
  );

  await collectWeek(
    input({
      roster: [['Alpha', P1]],
      editorial: {
        ...input().editorial,
        playlists: [{ id: 'pl-ff', name: 'Fresh Finds' }],
      },
      ai: scoutingAi,
    }),
    ports,
  );

  assert.deepEqual(
    source.requests[0].scouting.map((s) => [s.playlist, s.album.id]),
    [
      ['Lorem', 'alb-sc'],
      ['Ipsum', 'alb-sc'],
    ],
  );
  assert.deepEqual(
    judge.requests[0].candidates.map((c) => [
      c.id,
      c.provenance,
      c.spotifyAlbumId,
    ]),
    [
      [
        'scout-alb-sc',
        [
          { kind: 'scouting', playlist: 'Lorem' },
          { kind: 'scouting', playlist: 'Ipsum' },
        ],
        'alb-sc',
      ],
    ],
  );
});

test('a scouting release Deezer also found is one candidate listing both sources', async () => {
  const related = { kind: 'related' as const, to: ['Alpha', 'Beta'] };
  const reads = fixtureReads({
    artists: [smallArtist('sc')],
    playlistAlbums: { 'pl-lorem': ['alb-sc'] },
  });
  const { judge, ports } = aiPorts(
    reads,
    [
      candidate('dz-sc', {
        artist: 'Artist sc',
        title: 'Title sc',
        genres: ['Pop'],
        provenance: [related],
      }),
    ],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(input({ ai: scoutingAi }), ports);

  assert.deepEqual(
    judge.requests[0].candidates.map((c) => [
      c.id,
      c.provenance,
      c.spotifyAlbumId,
    ]),
    [['dz-sc', [related, { kind: 'scouting', playlist: 'Lorem' }], 'alb-sc']],
  );
  // Deezer's genres were enough for the veto.
  assert.deepEqual(reads.profileCalls, []);
});

test("a scouting release Deezer lacks takes its artist's Spotify genres, and the veto holds", async () => {
  const reads = fixtureReads({
    artists: [smallArtist('sc'), smallArtist('metal'), smallArtist('ghost')],
    playlistAlbums: { 'pl-lorem': ['alb-sc', 'alb-metal', 'alb-ghost'] },
    // No profile for the ghost: its genres can't be checked, so it's dropped.
    profiles: {
      'art-sc': profileWith(['indie pop']),
      'art-metal': profileWith(['death metal']),
    },
  });
  const { judge, ports } = aiPorts(reads, [], {
    ok: true,
    picks: [],
    spendUsd: 0.01,
  });

  await collectWeek(input({ ai: scoutingAi }), ports);

  assert.deepEqual(
    judge.requests[0].candidates.map((c) => [c.id, c.genres]),
    [['scout-alb-sc', ['indie pop']]],
  );
  assert.deepEqual(reads.profileCalls, ['art-sc', 'art-metal', 'art-ghost']);
});

test('scouting releases land only as picks, resolved by album id without a search', async () => {
  const reads = fixtureReads({
    artists: [alpha, smallArtist('sc'), smallArtist('other')],
    playlistAlbums: { 'pl-lorem': ['alb-sc', 'alb-other'] },
    profiles: {
      'art-sc': profileWith(['pop']),
      'art-other': profileWith(['pop']),
    },
  });
  const { ports } = aiPorts(reads, [], {
    ok: true,
    picks: [pick('scout-alb-sc', 80)],
    spendUsd: 0.01,
  });

  const week = await collectWeek(
    input({ roster: [['Alpha', P1]], ai: scoutingAi }),
    ports,
  );

  assert.deepEqual(week.tracks, ['t1', 'sc-t1']);
  assert.deepEqual(reads.upcCalls, []);
  assert.deepEqual(reads.searchCalls, ['Alpha']);
});

test('a scouting release merged with another source keeps it without a Spotify genre check', async () => {
  const roster = { kind: 'roster' as const, priority: 3 };
  const reads = fixtureReads({
    artists: [smallArtist('sc')],
    playlistAlbums: { 'pl-lorem': ['alb-sc'] },
    // No profile: a failed read must not cost the roster candidate.
  });
  const { judge, ports } = aiPorts(
    reads,
    [candidate('dz-sc', { artist: 'Artist sc', title: 'Title sc' })],
    { ok: true, picks: [], spendUsd: 0.01 },
  );

  await collectWeek(input({ ai: scoutingAi }), ports);

  assert.deepEqual(
    judge.requests[0].candidates.map((c) => [c.id, c.provenance]),
    [['dz-sc', [roster, { kind: 'scouting', playlist: 'Lorem' }]]],
  );
  assert.deepEqual(reads.profileCalls, []);
});
