#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';

const BASE = (process.env.RPS_URL || 'https://async-rps.codermeister.workers.dev').replace(/\/$/, '');
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'async-rps');
const CONFIG = join(CONFIG_DIR, 'config.json');
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
const KEYS = { r: 'rock', p: 'paper', s: 'scissors' };
const A = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m', yellow: '\x1b[33m' };
const BELL = '\x07';

const USAGE = `async-rps: rock paper scissors for people who are never online at the same time

  async-rps new [--players 3] [--best-of 3] [--name NAME]   create a game and take a seat
  async-rps join CODE [--name NAME]                          take a seat in a game
  async-rps throw CODE rock|paper|scissors                   lock in a throw for the current round
  async-rps show CODE                                        print the game
  async-rps play CODE [--mute]                               terminal UI: watch, join and throw
  async-rps seat                                             show your player id and how to move your seat
  async-rps version                                          print the CLI version

CODE may also be a full game link. --me ID adopts a seat from a personal link.
Set RPS_URL to point at another server. Identity lives in ${CONFIG}.`;

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

function identity(opts) {
  const c = loadConfig();
  if (opts.me) c.playerId = opts.me;
  c.playerId ||= randomUUID();
  if (opts.name) c.name = opts.name;
  c.name ||= process.env.USER || 'cli player';
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n');
  return c;
}

async function api(path, body) {
  const res = await fetch(`${BASE}/api${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function gameCode(arg) {
  const last = String(arg || '').split('/').filter(Boolean).pop() || '';
  return last.split('?')[0].toUpperCase();
}

// Emoji render two cells wide and color codes render zero, so pad by visible width.
const cell = (text, visible, width, color = '') => `${color}${text}${color ? A.reset : ''}${' '.repeat(Math.max(0, width - visible))}`;

function summary(s, opts = {}) {
  const you = s.players.find((p) => p.you);
  const lines = [];
  lines.push(`${A.bold}Game ${s.id}${A.reset}  ${s.playerCount} players, best of ${s.bestOf} (first to ${s.target})  ${A.dim}${s.status}${A.reset}`);
  lines.push(`${A.dim}${BASE}/g/${s.id}${A.reset}`);
  lines.push('');
  for (const p of s.players) {
    const lock = s.currentRound ? (s.currentRound.submitted.includes(p.name) ? '🔒' : '💭') : '  ';
    const label = p.you ? `${p.name} (you)` : p.name;
    lines.push(`  ${lock} ${cell(label, label.length, 22, p.you ? A.blue : '')} ${p.wins} ${p.wins === 1 ? 'win' : 'wins'}`);
  }
  const open = s.playerCount - s.players.length;
  if (open > 0) lines.push(`  ${A.dim}${open} more ${open === 1 ? 'seat' : 'seats'} open${A.reset}`);
  lines.push('');
  if (s.status === 'finished') {
    lines.push(!you ? `🏆 ${s.winner} wins!` : you.name === s.winner ? `${A.green}🏆 You win!${A.reset}` : `${A.red}🏳️  ${s.winner} wins. Not your day.${A.reset}`);
  } else if (!s.joined) {
    lines.push(open > 0 ? (opts.tui ? `Press ${A.bold}j${A.reset} to join as ${opts.name}` : 'Seats are open. Join with: async-rps join ' + s.id) : 'You are spectating.');
  } else if (s.currentRound.yourChoice) {
    const waiting = s.players.filter((p) => !s.currentRound.submitted.includes(p.name)).map((p) => p.name);
    if (open > 0) waiting.push(`${open} more to join`);
    lines.push(`Round ${s.currentRound.round}: you threw ${EMOJI[s.currentRound.yourChoice]} ${s.currentRound.yourChoice}. Waiting on ${waiting.join(', ')}.`);
  } else {
    lines.push(`Round ${s.currentRound.round}: your throw?  ${opts.tui ? `${A.bold}r${A.reset}ock  ${A.bold}p${A.reset}aper  ${A.bold}s${A.reset}cissors` : `async-rps throw ${s.id} rock|paper|scissors`}`);
  }
  if (s.rounds.length) {
    lines.push('');
    lines.push(`  ${A.dim}#   ${s.players.map((p) => p.name.slice(0, 8).padEnd(9)).join('')}${A.reset}`);
    for (const r of [...s.rounds].reverse()) {
      const cells = r.choices.map((c) => {
        if (!r.winningThrow) return cell(EMOJI[c.choice], 2, 9);
        const won = c.choice === r.winningThrow;
        return `${EMOJI[c.choice]}${cell(won ? '✔' : '✘', 1, 7, won ? A.green : A.red)}`;
      });
      lines.push(`  ${String(r.round).padEnd(4)}${cells.join('')}${r.winningThrow ? '' : `${A.dim}tie${A.reset}`}`);
    }
  }
  return lines.join('\n');
}

// Same backoff as the web page: quick after activity, then 15s, then 60s.
const pollInterval = (idleMs) => (idleMs < 2 * 60 * 1000 ? 3000 : idleMs < 15 * 60 * 1000 ? 15000 : 60000);

async function play(id, me, opts) {
  if (!stdin.isTTY) throw new Error('play needs a terminal; use show and throw instead');
  let state = null, msg = '', muted = !!opts.mute, seenRounds = null, timer = null, lastChange = Date.now();
  const render = () => {
    const body = state ? summary(state, { tui: true, name: me.name }) : 'Loading...';
    const foot = `${A.dim}q quit  m ${muted ? 'unmute' : 'mute'}  refreshes every ${pollInterval(Date.now() - lastChange) / 1000}s${A.reset}`;
    stdout.write(`\x1b[2J\x1b[H${body}\n\n${msg ? `${A.yellow}${msg}${A.reset}\n` : ''}${foot}\n`);
  };
  const schedule = () => {
    clearTimeout(timer);
    if (state?.status !== 'finished') timer = setTimeout(refresh, pollInterval(Date.now() - lastChange));
  };
  const refresh = async () => {
    try {
      const s = await api(`/games/${id}?player=${me.playerId}`);
      if (JSON.stringify(s) !== JSON.stringify(state)) lastChange = Date.now();
      if (seenRounds !== null && s.rounds.length > seenRounds && !muted) stdout.write(BELL);
      seenRounds = s.rounds.length;
      state = s;
    } catch (err) { msg = err.message; }
    render();
    schedule();
  };
  const post = async (path, body, ok) => {
    lastChange = Date.now();
    try { state = await api(path, body); msg = ok; seenRounds = state.rounds.length; } catch (err) { msg = err.message; }
    render();
    schedule();
  };
  const quit = () => { stdout.write('\x1b[?1049l'); stdin.setRawMode(false); process.exit(0); };

  stdout.write('\x1b[?1049h');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', (key) => {
    if (key === 'q' || key === '\x03') return quit();
    lastChange = Date.now();
    if (key === 'm') { muted = !muted; return render(); }
    if (!state) return;
    if (key === 'j' && !state.joined) return post(`/games/${id}/join`, { playerId: me.playerId, name: me.name }, `Joined as ${me.name}`);
    const t = KEYS[key.toLowerCase()];
    if (t && state.joined && state.currentRound && !state.currentRound.yourChoice) {
      return post(`/games/${id}/choice`, { playerId: me.playerId, round: state.currentRound.round, choice: t }, `You threw ${t}`);
    }
  });
  await refresh();
}

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string', short: 'n' },
      players: { type: 'string', short: 'p', default: '3' },
      'best-of': { type: 'string', short: 'b', default: '3' },
      me: { type: 'string' },
      mute: { type: 'boolean', short: 'm', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, arg, arg2] = positionals;
  if (opts.help || !cmd) return console.log(USAGE);
  const me = identity(opts);

  switch (cmd) {
    case 'version':
      console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
      return;
    case 'seat':
      console.log(`Player id: ${me.playerId}\nName: ${me.name}\nMove this seat to a browser: ${BASE}/g/CODE?me=${me.playerId}\nAdopt a browser seat here: async-rps seat --me <id from your personal link>`);
      return;
    case 'new': {
      const { id } = await api('/games', { playerId: me.playerId, name: me.name, playerCount: Number(opts.players), bestOf: Number(opts['best-of']) });
      console.log(summary(await api(`/games/${id}?player=${me.playerId}`)));
      console.log(`\nInvite: ${BASE}/g/${id}\nPlay here: async-rps play ${id}`);
      return;
    }
    case 'join':
      if (!arg) throw new Error('join needs a game code');
      console.log(summary(await api(`/games/${gameCode(arg)}/join`, { playerId: me.playerId, name: me.name })));
      return;
    case 'throw': {
      if (!arg || !EMOJI[arg2]) throw new Error('usage: async-rps throw CODE rock|paper|scissors');
      const id = gameCode(arg);
      const s = await api(`/games/${id}?player=${me.playerId}`);
      if (!s.currentRound) throw new Error('This game is over');
      console.log(summary(await api(`/games/${id}/choice`, { playerId: me.playerId, round: s.currentRound.round, choice: arg2 })));
      return;
    }
    case 'show':
      if (!arg) throw new Error('show needs a game code');
      console.log(summary(await api(`/games/${gameCode(arg)}?player=${me.playerId}`)));
      return;
    case 'play':
      if (!arg) throw new Error('play needs a game code');
      return play(gameCode(arg), me, opts);
    default:
      throw new Error(`Unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
