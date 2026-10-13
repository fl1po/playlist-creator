/**
 * Eval for the Claude TasteJudge: runs it over the labelled weeks and reports
 * how its picks agree with the user's verdicts, with counted token sizes and
 * spend. Calls the real API (about $0.10 a week); not part of `pnpm test`.
 * Credentials: ANTHROPIC_API_KEY (also read from `.env`), else `ant auth login`.
 *
 * Labelled weeks live in `data/evals/taste-judge/<friday>.json` (gitignored:
 * they hold the user's roster). Seed one from an AI-pick prototype prompt dump
 * (branch `prototype/ai-pick-prompt`, `prototypes/ai-finds/runs/`):
 *
 *   pnpm eval:taste-judge -- --import <run>.prompt.txt <labels>.json
 *   pnpm eval:taste-judge [-- --threshold 50]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { anthropicKeyFromEnv } from '../lib/anthropic-key.js';
import { foldName } from '../lib/deezer-client.js';
import {
  claudeTasteJudge,
  judgeParams,
  MODEL,
  sdkParser,
} from '../services/ai-finds/claude-taste-judge.js';
import type {
  Candidate,
  CandidateProvenance,
  TasteContext,
  Tier,
} from '../services/week-collection/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEEKS_DIR = path.join(here, '../../data/evals/taste-judge');

interface LabelledWeek {
  friday: string;
  taste: TasteContext;
  candidates: Candidate[];
  /** The user's verdicts, by artist name. */
  labels: { wanted: string[]; unwanted: string[] };
}

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes('--import')) {
  const i = argv.indexOf('--import');
  importWeek(argv[i + 1], argv[i + 2]);
} else {
  await evaluate(Number(arg('threshold') ?? 50));
}

// ── Eval ─────────────────────────────────────────────────────────────────────

async function evaluate(threshold: number): Promise<void> {
  const files = fs.existsSync(WEEKS_DIR)
    ? fs
        .readdirSync(WEEKS_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
  if (!files.length) throw new Error(`No labelled weeks in ${WEEKS_DIR}`);
  const weeks: LabelledWeek[] = files.map((f) =>
    JSON.parse(fs.readFileSync(path.join(WEEKS_DIR, f), 'utf8')),
  );

  // The SDK resolves its own credentials: ANTHROPIC_API_KEY, else an
  // `ant auth login` profile. One judge across the weeks, as in a fill.
  const sdk = new Anthropic();
  const judge = claudeTasteJudge({
    apiKey: anthropicKeyFromEnv() ?? 'resolved by the SDK client',
    fillWeeks: weeks.length,
    client: sdkParser(sdk),
  });
  const total = { wanted: 0, unwanted: 0, missed: 0, rejected: 0, spend: 0 };

  console.log(`${MODEL}; threshold ${threshold}; ${weeks.length} week(s)\n`);
  for (const week of weeks) {
    const request = {
      taste: week.taste,
      candidates: week.candidates,
      budgetUsd: 1,
    };
    const {
      output_config: _,
      max_tokens: __,
      ...params
    } = judgeParams(request, false);
    const [all, prefix] = await Promise.all([
      sdk.messages.countTokens(params),
      sdk.messages.countTokens({
        ...params,
        messages: [{ role: 'user', content: '.' }],
      }),
    ]);

    const outcome = await judge.judge(request);
    total.spend += outcome.spendUsd;
    console.log(`## ${week.friday}`);
    console.log(
      `- ${week.taste.roster.length} roster artists, ${week.candidates.length} candidates; ` +
        `${all.input_tokens} input tokens (stable prefix ≈ ${prefix.input_tokens}); ` +
        `spend $${outcome.spendUsd.toFixed(4)}`,
    );
    if (!outcome.ok) {
      console.log(
        `- FAILED: ${outcome.failure}${'message' in outcome ? ` — ${outcome.message}` : ''}\n`,
      );
      continue;
    }

    const wanted = new Set(week.labels.wanted.map(foldName));
    const unwanted = new Set(week.labels.unwanted.map(foldName));
    const byId = new Map(week.candidates.map((c) => [c.id, c]));
    const verdict = (c: Candidate) =>
      wanted.has(foldName(c.artist))
        ? '✓'
        : unwanted.has(foldName(c.artist))
          ? '✗'
          : ' ';
    const picks = outcome.picks
      .flatMap((p) => {
        const c = byId.get(p.id);
        return c ? [{ ...p, c }] : [];
      })
      .sort((a, b) => b.confidence - a.confidence);
    const kept = picks.filter((p) => p.confidence >= threshold);
    const keptArtists = new Set(kept.map((p) => foldName(p.c.artist)));
    const inPool = new Set(week.candidates.map((c) => foldName(c.artist)));
    const missed = [...wanted].filter(
      (a) => inPool.has(a) && !keptArtists.has(a),
    );
    const rejected = [...unwanted].filter(
      (a) => inPool.has(a) && !keptArtists.has(a),
    );
    // Labels are per artist, so agreement is counted per artist too.
    const hits = [...wanted].filter((a) => keptArtists.has(a)).length;
    const misses = [...unwanted].filter((a) => keptArtists.has(a)).length;
    total.wanted += hits;
    total.unwanted += misses;
    total.missed += missed.length;
    total.rejected += rejected.length;

    console.log(
      `- ≥${threshold}: ${kept.length} picks (artists: ✓ ${hits} wanted, ✗ ${misses} unwanted); ` +
        `wanted left out: ${missed.length}; unwanted left out: ${rejected.length}`,
    );
    for (const { c, ...p } of picks) {
      const mark = p.confidence >= threshold ? '' : '   (below threshold)';
      console.log(
        `  ${verdict(c)} ${p.confidence} ${c.artist} – ${c.title}: ${p.reason}${mark}`,
      );
    }
    if (missed.length)
      console.log(`  wanted, not picked: ${missed.join(', ')}`);
    console.log('');
  }

  const labelled =
    total.wanted + total.unwanted + total.missed + total.rejected;
  const agree = total.wanted + total.rejected;
  console.log(
    `Total: ✓ ${total.wanted} / ✗ ${total.unwanted} at ≥${threshold}; ` +
      `agreement ${agree}/${labelled} labelled artists; spend $${total.spend.toFixed(4)}`,
  );
}

// ── Import from a prototype prompt dump ──────────────────────────────────────

function importWeek(promptFile: string, labelsFile: string): void {
  const text = fs.readFileSync(promptFile, 'utf8');
  const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
  const friday = text.match(/week ending Friday (\d{4}-\d{2}-\d{2})/)?.[1];
  if (!friday) throw new Error('No "week ending Friday" header in the dump');

  const week: LabelledWeek = {
    friday,
    taste: {
      roster: section(text, "## Listener's artists")
        .slice(1)
        .map((line) => {
          const m = line.match(/^(.*) \[(P[1-4]|unranked)\]$/);
          if (!m) throw new Error(`Bad roster line: ${line}`);
          return { name: m[1], tier: m[2] as Tier };
        }),
      acceptGenres: section(text, '## Genres the listener prefers')[0].split(
        ', ',
      ),
      weekReleases: section(text, "## Already in this week's playlist")
        .filter((line) => line !== '(nothing)')
        .map((line) => {
          const [artist, ...rest] = line.split(' – ');
          return {
            artist,
            release: rest.join(' – ').replace(/ \([a-z]+\)$/, ''),
          };
        }),
    },
    candidates: section(text, '## Candidates').slice(1).map(candidate),
    labels: { wanted: labels.wanted, unwanted: labels.unwanted },
  };
  fs.mkdirSync(WEEKS_DIR, { recursive: true });
  const out = path.join(WEEKS_DIR, `${friday}.json`);
  fs.writeFileSync(out, `${JSON.stringify(week, null, 2)}\n`);
  console.log(
    `Wrote ${out}: ${week.taste.roster.length} roster artists, ${week.candidates.length} candidates`,
  );
}

/** The non-blank lines under a `## ` header, up to the next one. */
function section(text: string, header: string): string[] {
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`No "${header}" section in the dump`);
  const lines = text.slice(start).split(/\r?\n/).slice(1);
  const end = lines.findIndex(
    (l) => l.startsWith('## ') || l.startsWith('==='),
  );
  return (end < 0 ? lines : lines.slice(0, end)).filter((l) => l.trim());
}

/** `id | artist | title | type | tracks | date | genres | fans | popularity | provenance` */
function candidate(line: string): Candidate {
  const cells = line.split(' | ');
  const [id, artist] = cells;
  const [type, tracks, date, genres, fans, popularity, provenance] =
    cells.slice(-7);
  const ratio = popularity.match(/= ([\d.]+)x/)?.[1];
  return {
    id,
    artist,
    title: cells.slice(2, -7).join(' | '),
    type,
    trackCount: Number(tracks) || 1,
    releaseDate: date,
    // Deezer genre names can hold a slash ("Rap/Hip Hop"): keep the cell whole.
    genres: genres === '-' ? [] : [genres],
    artistFans: Number(fans) || null,
    upc: null,
    relativePopularity: ratio === undefined ? null : Number(ratio),
    provenance: [prototypeProvenance(provenance)],
  };
}

function prototypeProvenance(s: string): CandidateProvenance {
  const roster = s.match(/^roster (?:P(\d)|unranked)$/);
  if (roster) {
    return { kind: 'roster', priority: roster[1] ? Number(roster[1]) : null };
  }
  // The dump names 4 seeds and counts the rest (`+N`): stand-ins keep the
  // count, so the prompt still renders `+N`.
  const related = s.match(/^related to (.*?)(?: \+(\d+))?$/);
  if (related) {
    const more = Array.from({ length: Number(related[2] ?? 0) }, () => '?');
    return { kind: 'related', to: [...related[1].split(', '), ...more] };
  }
  throw new Error(`Unknown provenance: ${s}`);
}
