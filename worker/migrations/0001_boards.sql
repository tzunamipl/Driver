-- Stage leaderboards: each player's best time per vehicle on an official stage version.

-- Fingerprint of the stage's timing points the entries were driven on; a change empties the board.
CREATE TABLE boards (
  stage TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
);

-- player = shortened SHA-256 of the player id; splits = JSON array of ms.
CREATE TABLE entries (
  stage TEXT NOT NULL,
  player TEXT NOT NULL,
  vehicle TEXT NOT NULL,
  name TEXT NOT NULL,
  total_ms INTEGER NOT NULL,
  splits TEXT NOT NULL,
  penalty_ms INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (stage, player, vehicle)
);

CREATE INDEX entries_by_time ON entries (stage, total_ms, at);
