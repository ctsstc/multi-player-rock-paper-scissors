# Async Rock Paper Scissors

Rock paper scissors for 2 to 8 people who are never online at the same time. Everyone locks in a throw whenever they get around to it. When the last one lands, the round resolves. First to the target wins.

- **Frontend**: one `public/index.html`, no build step. Polls the API every few seconds while a tab is open.
- **CLI**: `bin/async-rps.mjs`, dependency free, runnable straight from GitHub with `npx`. See [CLI](#cli).
- **API**: a Cloudflare Worker using [Hono](https://hono.dev), in `src/`.
- **State**: [Turso](https://turso.tech) (libSQL). Three tables, see `schema.sql`.
- **Sound**: a short chime plays when a round resolves, a longer one when the game ends, and a two-note blip when someone else joins while your tab is open, all synthesized with the Web Audio API. The bell button in the game header mutes it per browser. Coming back to a game you are in also plays the chime for whatever resolved while you were away. Browsers block audio on a page that has not been clicked yet, so sounds play only once the browser allows them; nothing is queued for later.
- **Link previews**: `/g/CODE` pages are served through HTMLRewriter with Open Graph tags that say you have been invited and name the format, so Discord and friends unfurl them nicely. The icon is `public/og.png`.
- **Identity**: no auth. Each browser mints a random id into `localStorage` on first visit and picks a display name per game. Names are unique within a game. Once joined, the page offers a personal link (`/g/CODE?me=<id>`) that moves your seat to another browser; the page stores the id and strips it from the address bar.

## Rules

Each round every player picks rock, paper or scissors. Picks are hidden until everyone has locked in. You can throw the moment you have a seat, before the other seats are even filled; a round resolves once every seat is taken and every player has thrown.

- If exactly two different throws are on the table, the one that beats the other wins. Everyone who threw it gets a point.
- If everyone threw the same thing, or all three throws are present, the round is a tie and you go again.
- "Best of N" means first to `ceil(N / 2)` points. If two people reach it in the same round, play continues until someone is strictly ahead.

Round outcomes are never stored. They are derived from the `choices` table on every read, which means there is no state machine to get out of sync and simultaneous submits cannot race each other.

Live at https://async-rps.codermeister.workers.dev (Turso database `rps`, aws-us-west-2).

## Deploy

```bash
pnpm install
turso db create rps
turso db shell rps < schema.sql
turso db show rps --url
turso db tokens create rps
```

Put the URL into `vars.TURSO_DATABASE_URL` in `wrangler.jsonc`, then:

```bash
pnpm wrangler secret put TURSO_AUTH_TOKEN
pnpm deploy
```

Wrangler serves `public/` as static assets and routes everything else through the Worker. Share `https://<your-worker>.workers.dev/g/<CODE>` links.

## Local development

`pnpm dev:local` needs no Turso account. It runs the same Hono app under Node against a SQLite file (`local.db`) and serves `public/` on http://localhost:8787.

To run under the real Workers runtime, point `wrangler dev` at a local libSQL server instead:

```bash
turso dev --db-file local.db
turso db shell http://127.0.0.1:8080 < schema.sql
cp .dev.vars.example .dev.vars
pnpm dev
```

(`docker run -p 8080:8080 ghcr.io/tursodatabase/libsql-server` works in place of `turso dev`.)

```bash
pnpm test        # game logic and API tests, in-memory libSQL
pnpm typecheck
```

## API

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/games` | `playerId, name, playerCount, bestOf` | Creates the game and seats the creator. Returns `{ id }`. |
| GET | `/api/games/:id?player=<id>` | | Full state. Current round choices are hidden except your own. |
| POST | `/api/games/:id/join` | `playerId, name` | Idempotent for an existing seat. 409 when full or the name is taken. |
| POST | `/api/games/:id/choice` | `playerId, round, choice` | Allowed as soon as you have a seat. 409 if the round moved on, you already locked in, or the game is over. |

## CLI

No install, no dependencies, Node 18 or newer:

```bash
npx github:ctsstc/multi-player-rock-paper-scissors play CODE
```

`play` is a small terminal UI: it polls, shows the table, and takes `r`, `p`, `s` to throw, `j` to join, `m` to mute the bell, `q` to quit. The one-off commands are for people who would rather not leave a screen open:

```bash
npx github:ctsstc/multi-player-rock-paper-scissors new --players 3 --best-of 3 --name Cody
npx github:ctsstc/multi-player-rock-paper-scissors join CODE --name Cody
npx github:ctsstc/multi-player-rock-paper-scissors throw CODE rock
npx github:ctsstc/multi-player-rock-paper-scissors show CODE
```

Your seat lives in `~/.config/async-rps/config.json`. `seat` prints the id and a link that moves the seat to a browser; `--me <id>` adopts a seat from a browser's personal link. `RPS_URL` points the CLI at another server, such as `http://localhost:8787` for `pnpm dev:local`. From a checkout, `pnpm cli` runs the same script.

## For agents

Too busy to throw? The API is the whole game, so hand the link to your assistant. Paste this section at it.

> [!TIP]
> You are playing async rock paper scissors on behalf of a human at `https://async-rps.codermeister.workers.dev`. Pick a name they would recognize.

1. Mint a seat. Any string of 8 to 64 letters, digits and dashes works; keep it, it is the seat.

   ```bash
   ID=$(uuidgen); echo "$ID"
   ```

2. Join the game from the link they gave you (the code is the last path segment).

   ```bash
   curl -s -X POST https://async-rps.codermeister.workers.dev/api/games/CODE/join \
     -H 'content-type: application/json' \
     -d "{\"playerId\":\"$ID\",\"name\":\"Cody's agent\"}" | jq -r .status
   ```

3. Poll, and throw whenever `currentRound.yourChoice` is null. Stop when `status` is `finished`.

   ```bash
   while :; do
     S=$(curl -s "https://async-rps.codermeister.workers.dev/api/games/CODE?player=$ID")
     [ "$(echo "$S" | jq -r .status)" = finished ] && echo "$S" | jq -r '"winner: " + .winner' && break
     if [ "$(echo "$S" | jq -r '.currentRound.yourChoice')" = null ]; then
       R=$(echo "$S" | jq -r .currentRound.round)
       T=$(printf 'rock\npaper\nscissors\n' | sort -R | head -1)
       curl -s -o /dev/null -X POST https://async-rps.codermeister.workers.dev/api/games/CODE/choice \
         -H 'content-type: application/json' -d "{\"playerId\":\"$ID\",\"round\":$R,\"choice\":\"$T\"}"
       echo "round $R: threw $T"
     fi
     sleep 30
   done
   ```

Strategy is left as an exercise. Rock is a fine opening. Hand the human the personal link `/g/CODE?me=$ID` when they want their seat back.

> [!NOTE]
> The player id is the only secret. Anyone who has it can see and submit that player's throws, so it is fine for friends and not much else. Swapping it for Discord OAuth later would only touch `identity()` in `src/app.ts` and the two `localStorage` reads in `public/index.html`.
