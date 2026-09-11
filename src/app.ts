import { Hono } from 'hono';
import type { Client } from '@libsql/client';
import { deriveState, gameCode, isThrow, type ChoiceRow, type GameRow, type PlayerRow } from './game.ts';

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const CODE_RE = /^[A-Z0-9]{4,12}$/;

class BadRequest extends Error {
  status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

function identity(body: Record<string, unknown>) {
  const playerId = body.playerId;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (typeof playerId !== 'string' || !ID_RE.test(playerId)) throw new BadRequest('Missing player id');
  if (name.length < 1 || name.length > 20) throw new BadRequest('Name must be 1 to 20 characters');
  return { playerId, name };
}

function isUniqueViolation(err: unknown, column: string) {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message) && err.message.includes(column);
}

async function loadGame(db: Client, id: string) {
  const [g, p, c] = await db.batch(
    [
      { sql: 'SELECT id, player_count, best_of FROM games WHERE id = ?', args: [id] },
      { sql: 'SELECT id, name, seat FROM players WHERE game_id = ? ORDER BY seat', args: [id] },
      { sql: 'SELECT round, player_id, choice FROM choices WHERE game_id = ? ORDER BY round', args: [id] },
    ],
    'read',
  );
  const game = g.rows[0] as unknown as GameRow | undefined;
  if (!game) throw new BadRequest('Game not found', 404);
  return { game, players: p.rows as unknown as PlayerRow[], choices: c.rows as unknown as ChoiceRow[] };
}

export async function gameSummary(db: Client, id: string) {
  if (!CODE_RE.test(id)) return null;
  const r = await db.execute({ sql: 'SELECT player_count, best_of FROM games WHERE id = ?', args: [id] });
  return (r.rows[0] as unknown as { player_count: number; best_of: number } | undefined) ?? null;
}

async function stateOf(db: Client, id: string, viewerId: string | null) {
  const { game, players, choices } = await loadGame(db, id);
  return deriveState(game, players, choices, viewerId);
}

export function createApp(db: Client) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Server error' }, 500);
  });

  const api = new Hono();

  api.post('/games', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { playerId, name } = identity(body);
    const playerCount = Number(body.playerCount);
    const bestOf = Number(body.bestOf);
    if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 8) throw new BadRequest('Players must be 2 to 8');
    if (!Number.isInteger(bestOf) || bestOf < 1 || bestOf > 15) throw new BadRequest('Best of must be 1 to 15');

    const id = gameCode();
    await db.batch(
      [
        { sql: 'INSERT INTO games (id, player_count, best_of) VALUES (?, ?, ?)', args: [id, playerCount, bestOf] },
        { sql: 'INSERT INTO players (game_id, id, name, seat) VALUES (?, ?, ?, 0)', args: [id, playerId, name] },
      ],
      'write',
    );
    return c.json({ id }, 201);
  });

  api.get('/games/:id', async (c) => {
    const id = c.req.param('id').toUpperCase();
    if (!CODE_RE.test(id)) throw new BadRequest('Game not found', 404);
    return c.json(await stateOf(db, id, c.req.query('player') ?? null));
  });

  api.post('/games/:id/join', async (c) => {
    const id = c.req.param('id').toUpperCase();
    const { playerId, name } = identity(await c.req.json().catch(() => ({})));
    const { game, players } = await loadGame(db, id);

    if (!players.some((p) => p.id === playerId)) {
      if (players.length >= game.player_count) throw new BadRequest('Game is full', 409);
      // sqld's parser rejects HAVING without GROUP BY, so the seat guard is a filtered subquery.
      const res = await db
        .execute({
          sql: `INSERT INTO players (game_id, id, name, seat)
                SELECT ?1, ?2, ?3, seats.n
                FROM (SELECT COUNT(*) AS n FROM players WHERE game_id = ?1) AS seats
                WHERE seats.n < (SELECT player_count FROM games WHERE id = ?1)`,
          args: [id, playerId, name],
        })
        .catch((err) => {
          if (isUniqueViolation(err, 'players.name')) throw new BadRequest('That name is taken in this game', 409);
          if (isUniqueViolation(err, 'players.seat')) throw new BadRequest('Game is full', 409);
          throw err;
        });
      if (res.rowsAffected === 0) throw new BadRequest('Game is full', 409);
    }
    return c.json(await stateOf(db, id, playerId));
  });

  api.post('/games/:id/choice', async (c) => {
    const id = c.req.param('id').toUpperCase();
    const body = await c.req.json().catch(() => ({}));
    const playerId = body.playerId;
    if (typeof playerId !== 'string' || !ID_RE.test(playerId)) throw new BadRequest('Missing player id');
    if (!isThrow(body.choice)) throw new BadRequest('Choice must be rock, paper or scissors');

    const state = await stateOf(db, id, playerId);
    if (!state.joined) throw new BadRequest('You are not in this game', 403);
    if (state.status === 'finished') throw new BadRequest('This game is over', 409);
    const round = state.currentRound!;
    if (Number(body.round) !== round.round) throw new BadRequest(`Round ${body.round} already resolved`, 409);
    if (round.yourChoice) throw new BadRequest('You already locked in this round', 409);

    await db
      .execute({
        sql: 'INSERT INTO choices (game_id, round, player_id, choice) VALUES (?, ?, ?, ?)',
        args: [id, round.round, playerId, body.choice],
      })
      .catch((err) => {
        if (isUniqueViolation(err, 'choices')) throw new BadRequest('You already locked in this round', 409);
        throw err;
      });
    return c.json(await stateOf(db, id, playerId));
  });

  api.all('*', (c) => c.json({ error: 'Not found' }, 404));
  app.route('/api', api);
  return app;
}
