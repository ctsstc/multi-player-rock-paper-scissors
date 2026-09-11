import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { createApp } from './app.ts';

const db = createClient({ url: ':memory:' });
await db.executeMultiple(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const app = createApp(db);

const A = 'aaaaaaaa-0000-4000-8000-000000000000';
const B = 'bbbbbbbb-0000-4000-8000-000000000000';
const C = 'cccccccc-0000-4000-8000-000000000000';
const D = 'dddddddd-0000-4000-8000-000000000000';

async function call(path: string, body?: unknown) {
  const res = await app.request(
    path,
    body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined,
  );
  return { status: res.status, data: (await res.json()) as any };
}

async function expectError(path: string, body: unknown, status: number, pattern: RegExp) {
  const res = await call(path, body);
  assert.equal(res.status, status, `${path}: ${JSON.stringify(res.data)}`);
  assert.match(res.data.error, pattern);
}

test('create validation', async () => {
  await expectError('/api/games', {}, 400, /player id/);
  await expectError('/api/games', { playerId: A, name: '   ' }, 400, /Name/);
  await expectError('/api/games', { playerId: A, name: 'Ann', playerCount: 1, bestOf: 3 }, 400, /Players/);
  await expectError('/api/games', { playerId: A, name: 'Ann', playerCount: 3, bestOf: 0 }, 400, /Best of/);
  assert.equal((await call('/api/games/NOPE')).status, 404);
  assert.equal((await call('/api/games/not-a-code')).status, 404);
});

test('full three player game', async () => {
  const created = await call('/api/games', { playerId: A, name: 'Ann', playerCount: 3, bestOf: 3 });
  assert.equal(created.status, 201);
  const id: string = created.data.id;
  const url = `/api/games/${id}`;

  let s = (await call(`${url}?player=${A}`)).data;
  assert.equal(s.status, 'waiting');
  assert.equal(s.joined, true);
  assert.deepEqual(s.players, [{ name: 'Ann', wins: 0, you: true }]);
  s = (await call(`${url}/choice`, { playerId: A, round: 1, choice: 'rock' })).data;
  assert.equal(s.status, 'waiting');
  assert.equal(s.currentRound.yourChoice, 'rock');
  await expectError(`${url}/choice`, { playerId: A, round: 1, choice: 'paper' }, 409, /already/);

  assert.equal((await call(`${url.toLowerCase()}/join`, { playerId: B, name: 'Bob' })).status, 200);
  await expectError(`${url}/join`, { playerId: C, name: 'bob' }, 409, /taken/);
  s = (await call(`${url}/join`, { playerId: C, name: 'Cat' })).data;
  assert.equal(s.status, 'playing');
  assert.deepEqual(s.currentRound, { round: 1, submitted: ['Ann'], yourChoice: null });
  await expectError(`${url}/join`, { playerId: D, name: 'Dan' }, 409, /full/);
  assert.equal((await call(`${url}/join`, { playerId: A, name: 'Ann' })).status, 200);
  await expectError(`${url}/choice`, { playerId: D, round: 1, choice: 'rock' }, 403, /not in/);

  s = (await call(`${url}?player=${B}`)).data;
  assert.deepEqual(s.currentRound, { round: 1, submitted: ['Ann'], yourChoice: null });
  assert.equal(JSON.stringify(s).includes('rock'), false);

  await call(`${url}/choice`, { playerId: B, round: 1, choice: 'paper' });
  s = (await call(`${url}/choice`, { playerId: C, round: 1, choice: 'paper' })).data;
  assert.equal(s.rounds.length, 1);
  assert.equal(s.rounds[0].winningThrow, 'paper');
  assert.deepEqual(s.players.map((p: any) => p.wins), [0, 1, 1]);
  assert.equal(s.currentRound.round, 2);
  await expectError(`${url}/choice`, { playerId: A, round: 1, choice: 'rock' }, 409, /Round 1/);
  await expectError(`${url}/choice`, { playerId: A, round: 2, choice: 'lizard' }, 400, /rock, paper or scissors/);

  await call(`${url}/choice`, { playerId: A, round: 2, choice: 'rock' });
  await call(`${url}/choice`, { playerId: B, round: 2, choice: 'rock' });
  s = (await call(`${url}/choice`, { playerId: C, round: 2, choice: 'scissors' })).data;
  assert.equal(s.status, 'finished');
  assert.equal(s.winner, 'Bob');
  assert.deepEqual(s.players.map((p: any) => p.wins), [1, 2, 1]);
  await expectError(`${url}/choice`, { playerId: A, round: 3, choice: 'rock' }, 409, /over/);
});

test('unknown api route is json 404', async () => {
  const res = await call('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'Not found');
});
