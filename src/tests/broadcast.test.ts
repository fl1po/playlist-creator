import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Response } from 'express';
import { createBroadcaster } from '../web/broadcast.js';

// ── Fake SSE response ────────────────────────────────────────────────────────

interface FakeClient {
  res: Response;
  /** Raw SSE frames written to this client. */
  frames: string[];
  /** `data:` payloads, parsed. */
  messages(): { type: string; data: unknown }[];
  /** The most recent `id:` seen — what EventSource would resend on reconnect. */
  lastEventId(): string | null;
}

function fakeClient(): FakeClient {
  const frames: string[] = [];
  const res = {
    writableEnded: false,
    write(chunk: string) {
      frames.push(chunk);
      return true;
    },
    on() {
      return this;
    },
  } as unknown as Response;

  const lines = () => frames.join('').split('\n');

  return {
    res,
    frames,
    messages: () =>
      lines()
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6))),
    lastEventId: () => {
      const ids = lines().filter((l) => l.startsWith('id: '));
      return ids.length ? (ids[ids.length - 1] as string).slice(4) : null;
    },
  };
}

test('a fresh client receives the full log history', () => {
  const b = createBroadcaster();
  const first = fakeClient();
  b.addClient(first.res, 'u1');
  b.broadcastTo('u1', 'log', { level: 'info', message: 'one' });
  b.broadcastTo('u1', 'log', { level: 'info', message: 'two' });

  const fresh = fakeClient();
  b.addClient(fresh.res, 'u1');

  const logs = fresh.messages().filter((m) => m.type === 'log');
  assert.deepEqual(
    logs.map((m) => (m.data as { message: string }).message),
    ['one', 'two'],
  );
});

test('a reconnecting client resumes instead of replaying the whole log', () => {
  const b = createBroadcaster();
  const live = fakeClient();
  b.addClient(live.res, 'u1');
  b.broadcastTo('u1', 'log', { level: 'info', message: 'before drop' });

  // Connection dies; EventSource reconnects with the id it last saw.
  const resumeId = live.lastEventId();
  assert.ok(resumeId, 'messages must carry an SSE id');
  b.removeClient(live.res);
  b.broadcastTo('u1', 'log', { level: 'info', message: 'while offline' });

  const reconnected = fakeClient();
  b.addClient(reconnected.res, 'u1', resumeId);

  const logs = reconnected.messages().filter((m) => m.type === 'log');
  assert.deepEqual(
    logs.map((m) => (m.data as { message: string }).message),
    ['while offline'],
    'already-delivered entries must not be re-sent',
  );
});

test('an event id from a previous process replays everything', () => {
  const b = createBroadcaster();
  b.broadcastTo('u1', 'log', { level: 'info', message: 'one' });

  // Server restarted: the boot prefix no longer matches, so the client's
  // position is meaningless and the in-memory history is all it has.
  const client = fakeClient();
  b.addClient(client.res, 'u1', 'staleboot-99');

  const logs = client.messages().filter((m) => m.type === 'log');
  assert.equal(logs.length, 1);
});

test('replayed events keep the timestamp of when they happened', async () => {
  const b = createBroadcaster();
  // The client renders log lines out of task events, so every type — not just
  // `log` — has to carry a timestamp or the replay reads as "just now".
  b.broadcastTo('u1', 'fill:start', { dates: ['31.07.26'] });
  const emittedAt = Date.now();
  await new Promise((r) => setTimeout(r, 15));

  const client = fakeClient();
  b.addClient(client.res, 'u1');

  const frames = client.frames.join('');
  const replayed = frames
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; ts?: number })
    .find((m) => m.type === 'fill:start');

  assert.ok(replayed?.ts, 'event must carry a timestamp');
  assert.ok(
    replayed.ts <= emittedAt,
    'timestamp must be the original, not the replay time',
  );
});

test('events carry the process that sent them, live and on replay', () => {
  const b = createBroadcaster();
  const live = fakeClient();
  b.addClient(live.res, 'u1');
  b.broadcastTo('u1', 'fill:start', { dates: ['31.07.26'] }, 'fill');
  b.broadcastTo('u1', 'log', { level: 'info', message: 'signed in' });

  const fresh = fakeClient();
  b.addClient(fresh.res, 'u1');

  for (const client of [live, fresh]) {
    const msgs = client.messages() as { type: string; task?: string }[];
    assert.equal(msgs.find((m) => m.type === 'fill:start')?.task, 'fill');
    assert.equal(msgs.find((m) => m.type === 'log')?.task, undefined);
  }
});

test('history is scoped per user', () => {
  const b = createBroadcaster();
  b.broadcastTo('u1', 'log', { level: 'info', message: 'mine' });

  const other = fakeClient();
  b.addClient(other.res, 'u2');
  assert.equal(other.messages().filter((m) => m.type === 'log').length, 0);
});

test('transient message types stay out of the replayed history', () => {
  const b = createBroadcaster();
  b.broadcastTo('u1', 'recalc:scanProgress', { done: 1 });
  b.broadcastTo('u1', 'log', { level: 'info', message: 'kept' });

  const client = fakeClient();
  b.addClient(client.res, 'u1');

  const replayed = client
    .messages()
    // `status` is part of every handshake, not the history.
    .filter((m) => m.type !== 'status');
  assert.deepEqual(
    replayed.map((m) => m.type),
    ['log'],
  );
});
