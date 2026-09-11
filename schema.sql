CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  player_count INTEGER NOT NULL,
  best_of INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS players (
  game_id TEXT NOT NULL REFERENCES games(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  seat INTEGER NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, id),
  UNIQUE (game_id, name),
  UNIQUE (game_id, seat)
);

CREATE TABLE IF NOT EXISTS choices (
  game_id TEXT NOT NULL REFERENCES games(id),
  round INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('rock', 'paper', 'scissors')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, round, player_id)
);
