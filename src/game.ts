export const THROWS = ['rock', 'paper', 'scissors'] as const;
export type Throw = (typeof THROWS)[number];

const BEATS: Record<Throw, Throw> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

export function isThrow(x: unknown): x is Throw {
  return typeof x === 'string' && (THROWS as readonly string[]).includes(x);
}

// A round only resolves when exactly two distinct throws are on the table.
export function winningThrow(throws: Iterable<Throw>): Throw | null {
  const distinct = [...new Set(throws)];
  if (distinct.length !== 2) return null;
  const [a, b] = distinct;
  return BEATS[a] === b ? a : b;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function gameCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export interface GameRow {
  id: string;
  player_count: number;
  best_of: number;
}

export interface PlayerRow {
  id: string;
  name: string;
  seat: number;
}

export interface ChoiceRow {
  round: number;
  player_id: string;
  choice: Throw;
}

export type Status = 'waiting' | 'playing' | 'finished';

export interface RoundResult {
  round: number;
  choices: { name: string; choice: Throw }[];
  winningThrow: Throw | null;
  winners: string[];
}

export interface GameState {
  id: string;
  playerCount: number;
  bestOf: number;
  target: number;
  status: Status;
  players: { name: string; wins: number; you: boolean }[];
  rounds: RoundResult[];
  currentRound: { round: number; submitted: string[]; yourChoice: Throw | null } | null;
  winner: string | null;
  joined: boolean;
}

export function deriveState(
  game: GameRow,
  players: PlayerRow[],
  choices: ChoiceRow[],
  viewerId: string | null,
): GameState {
  const byRound = new Map<number, Map<string, Throw>>();
  for (const c of choices) {
    let m = byRound.get(c.round);
    if (!m) byRound.set(c.round, (m = new Map()));
    m.set(c.player_id, c.choice);
  }

  const full = players.length === game.player_count;
  const wins = new Map(players.map((p) => [p.id, 0]));
  const rounds: RoundResult[] = [];
  let n = 1;
  while (byRound.get(n)?.size === game.player_count) {
    const m = byRound.get(n)!;
    const win = winningThrow(m.values());
    const winners = players.filter((p) => win !== null && m.get(p.id) === win);
    for (const p of winners) wins.set(p.id, wins.get(p.id)! + 1);
    rounds.push({
      round: n,
      choices: players.map((p) => ({ name: p.name, choice: m.get(p.id)! })),
      winningThrow: win,
      winners: winners.map((p) => p.name),
    });
    n++;
  }

  const target = Math.ceil(game.best_of / 2);
  const ranked = [...players].sort((a, b) => wins.get(b.id)! - wins.get(a.id)!);
  const [leader, runnerUp] = ranked;
  const winner =
    full && leader && wins.get(leader.id)! >= target && (!runnerUp || wins.get(leader.id)! > wins.get(runnerUp.id)!)
      ? leader
      : null;
  const status: Status = !full ? 'waiting' : winner ? 'finished' : 'playing';
  const current = byRound.get(n) ?? new Map<string, Throw>();

  return {
    id: game.id,
    playerCount: game.player_count,
    bestOf: game.best_of,
    target,
    status,
    players: players.map((p) => ({ name: p.name, wins: wins.get(p.id)!, you: p.id === viewerId })),
    rounds,
    currentRound:
      status !== 'finished'
        ? {
            round: n,
            submitted: players.filter((p) => current.has(p.id)).map((p) => p.name),
            yourChoice: (viewerId && current.get(viewerId)) || null,
          }
        : null,
    winner: winner?.name ?? null,
    joined: players.some((p) => p.id === viewerId),
  };
}
