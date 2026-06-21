# Chess Practice

A personal chess practice tool you play against bots, with a **self-tuning
rating** modeled on chess.com. It runs entirely in the browser (works great on
a phone), stores your profile locally, and adapts the opponent to your current
level so you improve in small, incremental steps.

No accounts, no server, no build step — just static files + a vendored chess
engine.

## Features

- **chess.com-style rating (250–2800).** Your rating lives in your profile and
  changes a little after every game (Elo with a small K), so progress is gradual.
- **Adaptive placement.** On first run you play ~4 quick calibration games whose
  difficulty adapts to your results, then your starting rating is set. Re-run any
  time from Settings → *Recalibrate*.
- **Opponents tuned to you.** "Play next opponent" matches you against a bot at —
  or just slightly above — your current rating. Choose the challenge level
  (Even / Slight stretch / Push me), or pick an exact rating with the fine slider.
- **In-game help (each toggleable in Settings):**
  - 💡 **Hints** — highlights a strong move.
  - **Eval bar** — live who's-winning bar.
  - ↩ **Takebacks**.
  - **Blunder warning** — warns before you play a move that drops ~2.5+ pawns.
- **Post-game review:** accuracy % for both sides, per-move labels
  (Best / Good / Inaccuracy / Mistake / Blunder), a **replay** stepper with the
  evaluation at every move, and **opening name** detection.
- **Puzzle mode** with its own **adaptive puzzle rating** — solve tactics from the
  bundled Lichess set; solving raises your puzzle rating and missing lowers it, so
  the puzzles get harder as you improve and easier when you slip. Hint / Retry /
  Show-solution / Next, with a puzzle-rating history graph. Switch via the
  **Play / Puzzles** tabs.
- **Feel:** sounds, light/dark mode, several board themes, resign & draw offer,
  legal-move dots, captured pieces, move list, board flip, promotion picker.

> The in-game help (eval bar / hints / review) uses a **full-strength** analysis
> pass, kept separate from your weakened opponent — so a 600-rated bot never gives
> you 600-rated advice.

## How the rating works

Difficulty is produced by **Stockfish** (vendored, single-threaded WASM):

- **1350–2800:** Stockfish's own `UCI_LimitStrength` / `UCI_Elo`.
- **250–1350:** below Stockfish's Elo floor, so we use a low *Skill Level*, a
  shallow search depth, and a probabilistic *blunder* model — at ~400 the bot
  visibly hangs pieces, like a real beginner.

After each game your rating updates with
`new = old + K·(score − expected)`, `expected = 1 / (1 + 10^((opp − you)/400))`.
The numbers are a calibrated approximation meant to *feel* like chess.com — not an
exact match to any official rating pool.

## Run it locally

The engine runs in a Web Worker, which browsers won't load from a raw `file://`
path — so serve the folder over HTTP:

```bash
cd Chess
python3 -m http.server 8000
# open http://localhost:8000
```

## Play it on your phone (GitHub Pages)

1. Push this branch to GitHub (already done if you're reading this there).
2. In the repo: **Settings → Pages**.
3. Under **Build and deployment → Source**, either:
   - **Deploy from a branch:** pick this branch and the `/ (root)` folder, **Save**; or
   - **GitHub Actions:** the included workflow (`.github/workflows/pages.yml`)
     deploys automatically on push.
4. Wait for the green check, then open the published URL
   (`https://<user>.github.io/chess/`) on your phone. Add it to your home screen
   for an app-like launch.

Everything (rating, record, history, settings) is saved in that browser's
`localStorage`, so use the same browser to keep your progress.

## Project layout

```
index.html        markup + layout
styles.css        responsive styling, themes, eval bar
js/engine.js      Stockfish Web Worker wrapper + job queue
js/difficulty.js  rating -> engine config (+ blunder model)
js/rating.js      Elo math, profile persistence, matchmaking
js/calibration.js adaptive placement controller
js/analysis.js    eval bar, hints, blunder check, review + accuracy
js/openings.js    opening-name detection
js/board.js       board rendering, tap-to-move + drag
js/settings.js    feature toggles + theme persistence
js/game.js        orchestrates everything
vendor/           chess.js (rules) + stockfish.js/.wasm (engine)
```
