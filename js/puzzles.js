/*
 * puzzles.js
 * Tactics puzzle mode with an independent, self-adjusting puzzle rating.
 * Puzzles come from the bundled Lichess set (assets/puzzles.json, each with a
 * rating); the next puzzle is picked near your current puzzle rating, which
 * goes up when you solve and down when you fail — so puzzles get harder as you
 * improve and easier when you slip.
 *
 * Lichess puzzle convention: the side to move in `fen` is the opponent; the
 * first move in `moves` is played automatically to reach the puzzle position,
 * then you must find the remaining moves (your moves at odd indices, the
 * opponent's replies played for you).
 */
(function (global) {
  'use strict';

  var puzzles = [];
  var loaded = false, loadErr = null, loading = false;
  var profile = null;

  var pgame = null;       // chess.js instance for the current puzzle
  var cur = null;         // current puzzle object
  var solIdx = 1;         // index into cur.moves of the next expected solver move
  var solverColor = 'w';
  var failed = false;     // a wrong move was made
  var recorded = false;   // rating already updated for this puzzle
  var done = false;       // puzzle finished (solved or revealed)
  var active = false;     // puzzle mode is the active mode
  var busy = false;       // animating a move; ignore input

  function $(id) { return document.getElementById(id); }

  /* --------------------------------------------------------------- data */
  function load() {
    if (loaded || loading) return;
    loading = true;
    fetch('assets/puzzles.json')
      .then(function (r) { return r.json(); })
      .then(function (d) { puzzles = d; loaded = true; loading = false; if (active) nextPuzzle(); })
      .catch(function (e) { loadErr = e; loading = false; if (active) $('pzObjective').textContent = 'Could not load puzzles.'; });
  }

  /* --------------------------------------------------------- board glue */
  function legalTargets(square) {
    var ms = pgame.moves({ square: square, verbose: true });
    var seen = {}, out = [];
    ms.forEach(function (m) {
      if (seen[m.to]) return;
      seen[m.to] = true;
      out.push({ to: m.to, capture: m.flags.indexOf('c') !== -1 || m.flags.indexOf('e') !== -1 });
    });
    return out;
  }
  function inCheckSquare() {
    if (!pgame || !pgame.in_check()) return null;
    var turn = pgame.turn(), b = pgame.board(), files = 'abcdefgh';
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var cell = b[r][c];
      if (cell && cell.type === 'k' && cell.color === turn) return files[c] + (8 - r);
    }
    return null;
  }

  var boardOpts = {
    getBoard: function () { return pgame.board(); },
    getTurn: function () { return pgame.turn(); },
    getPlayerColor: function () { return solverColor; },
    isInteractive: function () { return active && !busy && !done && pgame && pgame.turn() === solverColor; },
    legalTargets: legalTargets,
    pieceColorAt: function (sq) { var p = pgame.get(sq); return p ? p.color : null; },
    inCheckSquare: inCheckSquare,
    onMove: onSolverMove
  };

  /* --------------------------------------------------------- sound */
  var audioCtx = null;
  function tone(freq, dur, type) {
    try {
      audioCtx = audioCtx || new (global.AudioContext || global.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq; g.gain.value = 0.07;
      o.connect(g); g.connect(audioCtx.destination);
      var now = audioCtx.currentTime;
      g.gain.setValueAtTime(0.07, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.start(now); o.stop(now + dur);
    } catch (e) {}
  }

  /* --------------------------------------------------------- selection */
  function pickPuzzle() {
    var target = profile.puzzleRating;
    var seen = profile.puzzleSeen || [];
    var pool = [], win = 120;
    while (pool.length === 0 && win < 2500) {
      pool = puzzles.filter(function (p) { return Math.abs(p.rating - target) <= win && seen.indexOf(p.id) < 0; });
      win += 150;
    }
    if (pool.length === 0) pool = puzzles.filter(function (p) { return seen.indexOf(p.id) < 0; });
    if (pool.length === 0) { profile.puzzleSeen = []; pool = puzzles; }
    var pick = pool[Math.floor(Math.random() * pool.length)];
    var s = profile.puzzleSeen || [];
    s.push(pick.id); if (s.length > 300) s = s.slice(-300);
    profile.puzzleSeen = s;
    return pick;
  }

  function applyUci(uci) {
    return pgame.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  }

  function nextPuzzle() {
    if (!loaded) { load(); return; }
    cur = pickPuzzle();
    pgame = new Chess(cur.fen);
    solIdx = 1; failed = false; recorded = false; done = false; busy = true;
    var mover0 = pgame.turn();
    solverColor = (mover0 === 'w') ? 'b' : 'w';
    Board.setOrientation(solverColor);
    Board.setLastMove(null);
    Board.setHint(null);
    Board.render();
    feedback('', '');
    $('pzThemes').textContent = '';
    $('pzObjective').textContent = 'Get ready…';
    $('pzInfo').textContent = 'Puzzle rating ' + cur.rating;
    setButtons(false);

    // play the opponent's setup move, then hand over to the solver
    setTimeout(function () {
      var m = applyUci(cur.moves[0]);
      Board.setLastMove(m ? { from: m.from, to: m.to } : null);
      Board.render(m ? { from: m.from, to: m.to } : null);
      busy = false;
      $('pzObjective').textContent = (solverColor === 'w' ? 'White' : 'Black') + ' to move — find the best move';
      setButtons(true);
    }, 450);
  }

  function isPromotion(from, to) {
    var ms = pgame.moves({ square: from, verbose: true });
    for (var i = 0; i < ms.length; i++) if (ms[i].to === to && ms[i].flags.indexOf('p') !== -1) return true;
    return false;
  }
  function resultsInMate(moveObj) {
    try { var t = new Chess(pgame.fen()); var mv = t.move(moveObj); return mv && t.in_checkmate(); }
    catch (e) { return false; }
  }

  function onSolverMove(from, to) {
    if (!active || busy || done || pgame.turn() !== solverColor) return;
    var apply = function (promo) {
      var legal = pgame.moves({ square: from, verbose: true }).some(function (mm) { return mm.to === to; });
      if (!legal) return;
      var moveObj = { from: from, to: to }; if (promo) moveObj.promotion = promo;
      var uci = from + to + (promo || '');
      var expected = cur.moves[solIdx];
      var correct = (uci === expected) || resultsInMate(moveObj);

      if (!correct) {
        if (!recorded) { failed = true; finishRating(0); }
        feedback('Not the best move — try again.', 'bad');
        tone(180, 0.18, 'square');
        Board.clearSelection();
        return;
      }

      var mv = pgame.move(moveObj);
      Board.setLastMove({ from: mv.from, to: mv.to });
      Board.render({ from: mv.from, to: mv.to });
      tone(pgame.in_check() ? 700 : 440, 0.09, pgame.in_check() ? 'triangle' : 'sine');
      solIdx++;
      if (solIdx >= cur.moves.length) { finishSolved(); return; }

      // opponent's reply, played for you (wait for the solver's slide to finish)
      busy = true;
      feedback('Best move! Keep going…', 'good');
      setTimeout(function () {
        var rm = applyUci(cur.moves[solIdx]); solIdx++;
        Board.setLastMove(rm ? { from: rm.from, to: rm.to } : null);
        Board.render(rm ? { from: rm.from, to: rm.to } : null);
        busy = false;
        if (solIdx >= cur.moves.length) finishSolved();
      }, (Board.ANIM_MS || 320) + 80);
    };

    if (isPromotion(from, to)) promptPromotion(solverColor, apply);
    else apply(null);
  }

  function finishSolved() {
    done = true;
    if (!recorded) finishRating(1);
    feedback(failed ? 'Solved (with a miss).' : 'Solved! ✓', failed ? '' : 'good');
    revealThemes();
    setButtons(true, true);
    Board.setHint(null); Board.render();
  }

  function finishRating(score) {
    recorded = true;
    var change = Rating.recordPuzzle(profile, cur.rating, score);
    renderProfile();
    if (score === 0) {
      var sign = change.delta >= 0 ? '+' : '';
      $('pzInfo').textContent = 'Puzzle ' + cur.rating + '  ·  rating ' +
        change.before + ' → ' + change.after + ' (' + sign + change.delta + ')';
    } else {
      var sg = change.delta >= 0 ? '+' : '';
      $('pzInfo').textContent = 'Solved ' + cur.rating + '  ·  rating ' +
        change.before + ' → ' + change.after + ' (' + sg + change.delta + ')';
    }
  }

  function revealThemes() {
    if (cur.themes) $('pzThemes').textContent = 'Themes: ' + cur.themes;
  }

  /* --------------------------------------------------------- controls */
  function hint() {
    if (!active || done || !cur) return;
    var expected = cur.moves[solIdx];
    if (!expected) return;
    var from = expected.slice(0, 2);
    Board.setHint({ from: from, to: from }); // highlight the piece to move
    feedback('Move the highlighted piece.', '');
  }
  function retry() {
    if (!active || !cur) return;
    pgame = new Chess(cur.fen);
    solIdx = 1; done = false; busy = true;
    Board.setHint(null); Board.setLastMove(null); Board.render();
    feedback('', '');
    setTimeout(function () {
      var m = applyUci(cur.moves[0]);
      Board.setLastMove(m ? { from: m.from, to: m.to } : null);
      Board.render(m ? { from: m.from, to: m.to } : null); busy = false;
      $('pzObjective').textContent = (solverColor === 'w' ? 'White' : 'Black') + ' to move — find the best move';
    }, 300);
  }
  function showSolution() {
    if (!active || !cur || done) return;
    if (!recorded) { failed = true; finishRating(0); }
    done = true; busy = true;
    feedback('Solution:', '');
    var i = solIdx;
    (function step() {
      if (i >= cur.moves.length) {
        busy = false;
        revealThemes();
        setButtons(true, true);
        return;
      }
      var m = applyUci(cur.moves[i]); i++;
      Board.setLastMove(m ? { from: m.from, to: m.to } : null);
      Board.render(m ? { from: m.from, to: m.to } : null);
      setTimeout(step, 500);
    })();
  }

  /* --------------------------------------------------------- promotion */
  function promptPromotion(color, cb) {
    var overlay = $('promoOverlay');
    overlay.innerHTML = '';
    ['q', 'r', 'b', 'n'].forEach(function (p) {
      var btn = document.createElement('button');
      btn.className = 'promo-btn';
      btn.style.backgroundImage = "url('assets/pieces/" + color + p.toUpperCase() + ".svg')";
      btn.addEventListener('click', function () { overlay.classList.remove('open'); cb(p); });
      overlay.appendChild(btn);
    });
    overlay.classList.add('open');
  }

  /* --------------------------------------------------------- UI */
  function feedback(text, cls) {
    var el = $('pzFeedback');
    el.textContent = text || '';
    el.className = 'pz-feedback' + (cls ? ' ' + cls : '');
  }
  function setButtons(enabled, solved) {
    $('pzHint').disabled = !enabled || solved;
    $('pzRetry').disabled = !enabled;
    $('pzSolution').disabled = !enabled || solved;
  }
  function renderProfile() {
    $('pzRating').textContent = profile.puzzleRating;
    $('pzTag').textContent = Difficulty.botLabel(profile.puzzleRating);
    $('pzRecord').textContent = profile.puzzlesSolved + ' solved · ' + profile.puzzlesFailed + ' failed';
    renderSparkline();
  }
  function renderSparkline() {
    var pts = (profile.puzzleHistory || []).slice(-40).map(function (h) { return h.rating; });
    if (pts.length < 2) { $('pzSparkline').innerHTML = ''; return; }
    var w = 220, h = 48, pad = 4;
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    if (max === min) { max += 1; min -= 1; }
    var step = (w - 2 * pad) / (pts.length - 1);
    var path = pts.map(function (v, i) {
      var x = pad + i * step;
      var y = pad + (1 - (v - min) / (max - min)) * (h - 2 * pad);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    $('pzSparkline').innerHTML =
      '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' +
      '<path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2"/></svg>' +
      '<div class="spark-range">' + min + ' – ' + max + '</div>';
  }

  /* --------------------------------------------------------- lifecycle */
  function enter() {
    profile = global.GameApp.profile();
    active = true;
    renderProfile();
    if (!loaded) {
      $('pzObjective').textContent = 'Loading puzzles…';
      load();
    } else if (!cur) {
      nextPuzzle();
    } else {
      Board.setOrientation(solverColor);
      Board.render();
    }
  }
  function exit() { active = false; }

  function bind() {
    $('pzHint').addEventListener('click', hint);
    $('pzRetry').addEventListener('click', retry);
    $('pzSolution').addEventListener('click', showSolution);
    $('pzNext').addEventListener('click', function () { if (loaded) nextPuzzle(); else load(); });
  }

  global.Puzzles = {
    boardOpts: boardOpts,
    enter: enter,
    exit: exit,
    bind: bind,
    isActive: function () { return active; },
    _debug: {
      fen: function () { return pgame ? pgame.fen() : null; },
      solver: function () { return solverColor; },
      expected: function () { return cur ? cur.moves[solIdx] : null; },
      move: onSolverMove,
      done: function () { return done; },
      busy: function () { return busy; },
      loaded: function () { return loaded; },
      next: nextPuzzle
    }
  };
})(window);
