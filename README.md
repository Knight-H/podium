# podium

Ranked-choice voting for demo days, hackathons, and pitch nights — with a
cinematic awards reveal at the end.

Everyone ranks their top 3 favourites from their phone. You add teams to the
roster live as they present. When the last demo finishes you open voting, then
put the reveal screen on the projector: a 3–2–1 countdown, bronze → silver →
gold, drumroll, and confetti on the winner.

**One file. Zero dependencies. Just Node.**

```bash
node server.js
```

## Why it's built this way

No build step, no `npm install`, no database, no accounts. One `server.js`
serves three pages and a small JSON API, and state lives in a `data.json` file
next to it. You can run this on a laptop at a venue with flaky wifi and nothing
will fail to install at the worst possible moment.

## Quickstart

**1. Start the server**

```bash
node server.js              # defaults to port 8080
PORT=8090 node server.js    # or pick your own
```

It prints two URLs. The admin one carries a generated key — that key is your
password, so keep it off the projector:

```
Voter page : http://localhost:8090/
Admin page : http://localhost:8090/admin?key=abc123…
```

**2. Get a public URL** so phones in the room can reach it:

```bash
cloudflared tunnel --config /dev/null --url http://localhost:8090
```

> **`--config /dev/null` matters.** `cloudflared` silently auto-loads
> `~/.cloudflared/config.yml` if you have one. If that config defines a named
> tunnel with a catch-all ingress rule, your quick tunnel's hostname won't match
> it and every request returns an **empty HTTP 404 from Cloudflare's edge** —
> even though the tunnel says it registered fine and your local server returns
> 200. Isolating from the config fixes it. Confirm with the startup log line:
> it should read `config:/dev/null` and show no `cred-file`.

**3. Point the QR at that URL.** Open the admin page on **localhost** (keeps your
key off the internet), paste the `https://….trycloudflare.com` URL into the
*public URL* box, and hit **Set**. The QR code now points at the tunnel — show
it on the projector.

## Running a session

| Step | Where |
|---|---|
| Add each team as it presents | Admin → **Demos → Add** |
| Open voting after the last demo | Admin → **Open voting** |
| Watch points come in live | Admin → leaderboard |
| Close voting | Admin → **Close voting** |
| Run the ceremony | Admin → **🏆 Open reveal screen** |

Voting starts **closed** on purpose, so nobody ranks a partial field. Voters see
the roster grow while they wait.

## Pages

| Route | Who | What |
|---|---|---|
| `/` | the room | Pick who you are, then rank 1st / 2nd / 3rd |
| `/admin?key=…` | you | Roster, voting toggle, live leaderboard, QR, reset |
| `/reveal?key=…` | the projector | The awards ceremony |

## Scoring

**1st = 3 points · 2nd = 2 · 3rd = 1**, summed per team. The admin table also
breaks out how many 1st/2nd/3rd votes each team received, so ties are visible.
Ties break by most 1st-place votes, then by name.

## One vote per person

Voters identify themselves by picking their own name from the roster, so:

- one ballot per person, enforced server-side (re-submitting **overwrites**, it
  never stacks)
- you can't rank yourself — filtered out of the dropdowns *and* rejected by the API
- each rank dropdown hides teams already picked in another slot, so a duplicate
  ranking is impossible
- one device is additionally locked to one identity via `localStorage`
- voters can change their ballot until you close voting

**Honest limitation:** this is honor-system grade, not ballot-box grade. Someone
determined could use a second device. It's built for a friendly room, not an
election. If you need it airtight, hand out one-time access codes instead.

Note that voters pick their identity *from the roster* — so this assumes the
people voting are the ones presenting. For pure spectators you'd need to add a
"not listed" option.

## The reveal

Design thesis: **light is the hero.** The room goes dark, spotlight beams focus,
and the winner doesn't just get gold text — the whole screen blooms.

- lens-focus countdown (blur → sharp) with expanding shockwave rings
- medals are CSS-minted metal coins with a sweeping shine — no emoji, so it
  renders identically on every machine in the room
- names cascade in letter by letter; scores count up on a monospace odometer
- winner: white flash → light bloom → rotating rays → confetti and streamer
  cannons → gold shimmer across the name
- ambient dust motes and a slow indigo aurora, so the screen is never dead
- ends on a podium of lit pillars

**Sound** is synthesized with the Web Audio API — no audio files. Countdown
ticks, a whoosh and ding per reveal, a drumroll that swells through
*"And the winner is…"*, then cymbal, fanfare, and applause landing exactly on
the winner's flash. The browser unlocks audio on the **Begin the ceremony** tap.
Mute toggle is top-right. Route it to a real speaker — laptop-to-projector audio
is thin.

Tap the screen or press **Space** to skip ahead and control the pacing yourself.
`prefers-reduced-motion` is respected.

## Data and resetting

All state lives in `data.json` beside `server.js`: the admin key, the roster, and
every ballot. It is **gitignored** — it holds people's names and exactly who they
each voted for.

- **Clear all votes** — keeps the roster
- **Clear votes + demos** — full reset
- Or stop the server and `rm data.json` (this regenerates the admin key)

## Requirements

Node 18+. Nothing else. `cloudflared` only if you want a public URL.

## License

MIT
