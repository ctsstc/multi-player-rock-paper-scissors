import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState, gameCode, winningThrow, type ChoiceRow, type Throw } from './game.ts';

test('winningThrow resolves only when exactly two throws are present', () => {
  assert.equal(winningThrow(['rock', 'scissors']), 'rock');
  assert.equal(winningThrow(['scissors', 'paper', 'paper']), 'scissors');
  assert.equal(winningThrow(['paper', 'rock']), 'paper');
  assert.equal(winningThrow(['rock', 'rock', 'rock']), null);
  assert.equal(winningThrow(['rock', 'paper', 'scissors']), null);
});

test('gameCode avoids ambiguous characters', () => {
  for (let i = 0; i < 200; i++) assert.match(gameCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
});

const game = { id: 'ABC123', player_count: 3, best_of: 3 };
const players = [
  { id: 'a', name: 'Ann', seat: 0 },
  { id: 'b', name: 'Bob', seat: 1 },
  { id: 'c', name: 'Cat', seat: 2 },
];
const round = (n: number, a: Throw, b: Throw, c: Throw): ChoiceRow[] => [
  { round: n, player_id: 'a', choice: a },
  { round: n, player_id: 'b', choice: b },
  { round: n, player_id: 'c', choice: c },
];

test('waiting until the table is full', () => {
  const s = deriveState(game, players.slice(0, 2), [], 'a');
  assert.equal(s.status, 'waiting');
  assert.deepEqual(s.currentRound, { round: 1, submitted: [], yourChoice: null });
  assert.equal(s.joined, true);
  assert.equal(deriveState(game, players.slice(0, 2), [], 'zzz').joined, false);
});

test('early throws wait for the table to fill, then resolve', () => {
  const early: ChoiceRow[] = [
    { round: 1, player_id: 'a', choice: 'rock' },
    { round: 1, player_id: 'b', choice: 'scissors' },
  ];
  const s = deriveState(game, players.slice(0, 2), early, 'b');
  assert.equal(s.status, 'waiting');
  assert.equal(s.rounds.length, 0);
  assert.deepEqual(s.currentRound, { round: 1, submitted: ['Ann', 'Bob'], yourChoice: 'scissors' });
  const done = deriveState(game, players, [...early, { round: 1, player_id: 'c', choice: 'scissors' }], null);
  assert.equal(done.status, 'playing');
  assert.equal(done.rounds[0].winningThrow, 'rock');
});

test('ties count as rounds and award nothing', () => {
  const s = deriveState(game, players, round(1, 'rock', 'paper', 'scissors'), null);
  assert.equal(s.rounds.length, 1);
  assert.equal(s.rounds[0].winningThrow, null);
  assert.deepEqual(s.rounds[0].winners, []);
  assert.deepEqual(s.players.map((p) => p.wins), [0, 0, 0]);
  assert.equal(s.currentRound?.round, 2);
});

test('everyone holding the winning throw scores', () => {
  const s = deriveState(game, players, round(1, 'paper', 'paper', 'rock'), null);
  assert.equal(s.rounds[0].winningThrow, 'paper');
  assert.deepEqual(s.rounds[0].winners, ['Ann', 'Bob']);
  assert.deepEqual(s.players.map((p) => p.wins), [1, 1, 0]);
  assert.equal(s.status, 'playing');
});

test('current round hides other choices but shows your own', () => {
  const partial: ChoiceRow[] = [{ round: 1, player_id: 'a', choice: 'rock' }];
  const asB = deriveState(game, players, partial, 'b');
  assert.deepEqual(asB.currentRound, { round: 1, submitted: ['Ann'], yourChoice: null });
  assert.equal(asB.rounds.length, 0);
  const asA = deriveState(game, players, partial, 'a');
  assert.equal(asA.currentRound?.yourChoice, 'rock');
  assert.equal(JSON.stringify(asB).includes('"choice"'), false);
});

test('winner must hit the target and be strictly ahead', () => {
  const tied = [...round(1, 'paper', 'paper', 'rock'), ...round(2, 'paper', 'paper', 'rock')];
  let s = deriveState(game, players, tied, null);
  assert.deepEqual(s.players.map((p) => p.wins), [2, 2, 0]);
  assert.equal(s.status, 'playing');
  assert.equal(s.winner, null);

  s = deriveState(game, players, [...tied, ...round(3, 'scissors', 'paper', 'paper')], null);
  assert.equal(s.status, 'finished');
  assert.equal(s.winner, 'Ann');
  assert.equal(s.currentRound, null);
});

test('best of 1 ends on the first decisive round', () => {
  const s = deriveState({ ...game, best_of: 1 }, players, round(1, 'rock', 'scissors', 'scissors'), null);
  assert.equal(s.target, 1);
  assert.equal(s.winner, 'Ann');
});
