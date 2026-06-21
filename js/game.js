/*
 * game.js
 * Orchestrates the whole app: game state, player + engine moves, blunder
 * injection, in-game help (hint / eval bar / blunder warning / takeback),
 * resign / draw, calibration, Elo updates, post-game review + replay, and all
 * the DOM wiring.
 */
(function (global) {
  'use strict';

  var game = new Chess();
  var profile = Rating.loadProfile();

  var playerColor = 'w';
  var oppRating = 800;
  var mode = 'normal';            // 'normal' | 'calibration'
  var gameOver = false;
  var thinking = false;
  var boardActive = true;         // false while Puzzle mode owns the board
  var engineSeq = 0;              // bumped to cancel an in-flight engine move (e.g. on takeback)

  var sans = [];                  // SAN per ply
  var fens = [game.fen()];        // position after each ply (fens[0] = start)
  var lastMove = null;

  // replay state
  var replayActive = false;
  var replayGame = new Chess();
  var replayIndex = 0;
  var reviewData = null;

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------------ sound */
  var audioCtx = null;
  function tone(freq, dur, type) {
    if (!Settings.get('sounds')) return;
    try {
      audioCtx = audioCtx || new (global.AudioContext || global.webkitAudioContext)();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      var now = audioCtx.currentTime;
      g.gain.setValueAtTime(0.08, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.start(now); o.stop(now + dur);
    } catch (e) {}
  }
  function soundFor(move) {
    if (game.in_check()) tone(720, 0.16, 'triangle');
    else if (move.captured) tone(300, 0.12, 'square');
    else tone(420, 0.08, 'sine');
  }

  /* ----------------------------------------------------------- board glue */
  function legalTargets(square) {
    var ms = game.moves({ square: square, verbose: true });
    var seen = {};
    var out = [];
    ms.forEach(function (m) {
      if (seen[m.to]) return;
      seen[m.to] = true;
      out.push({ to: m.to, capture: m.flags.indexOf('c') !== -1 || m.flags.indexOf('e') !== -1 });
    });
    return out;
  }
  function pieceColorAt(sq) {
    var p = (replayActive ? replayGame : game).get(sq);
    return p ? p.color : null;
  }
  function inCheckSquare() {
    var g = replayActive ? replayGame : game;
    if (!g.in_check()) return null;
    var turn = g.turn();
    var b = g.board();
    var files = 'abcdefgh';
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var cell = b[r][c];
      // board() cells have no .square in chess.js 0.10.x; derive it.
      if (cell && cell.type === 'k' && cell.color === turn) return files[c] + (8 - r);
    }
    return null;
  }

  var boardOpts = {
    getBoard: function () { return (replayActive ? replayGame : game).board(); },
    getTurn: function () { return game.turn(); },
    getPlayerColor: function () { return playerColor; },
    isInteractive: function () { return !replayActive && !gameOver && !thinking && game.turn() === playerColor; },
    legalTargets: legalTargets,
    pieceColorAt: pieceColorAt,
    inCheckSquare: inCheckSquare,
    onMove: onPlayerMove
  };

  /* ----------------------------------------------------------- move flow */
  function needsPromotion(from, to) {
    var ms = game.moves({ square: from, verbose: true });
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].to === to && ms[i].flags.indexOf('p') !== -1) return true;
    }
    return false;
  }

  function onPlayerMove(from, to) {
    if (game.turn() !== playerColor || gameOver || thinking) return;
    var finish = function (promotion) {
      var fenBefore = game.fen();
      var test = new Chess(fenBefore);
      var trial = test.move({ from: from, to: to, promotion: promotion || 'q' });
      if (!trial) return;
      var fenAfter = test.fen();

      var doMove = function () {
        var move = game.move({ from: from, to: to, promotion: promotion || 'q' });
        if (!move) return;
        commitMove(move);
        if (!gameOver && game.turn() !== playerColor) engineMove();
      };

      if (Settings.get('blunderWarning') && mode === 'normal') {
        setThinking(true, 'Checking move…');
        Analysis.moveCpLoss(fenBefore, fenAfter, playerColor).then(function (loss) {
          setThinking(false);
          if (loss >= 250) {
            if (!global.confirm('That move looks like a blunder (loses ~' +
              (loss / 100).toFixed(1) + ' pawns). Play it anyway?')) {
              Board.render();
              return;
            }
          }
          doMove();
        }).catch(function () { setThinking(false); doMove(); });
      } else {
        doMove();
      }
    };

    if (needsPromotion(from, to)) {
      promptPromotion(playerColor, finish);
    } else {
      finish(null);
    }
  }

  function commitMove(move) {
    lastMove = { from: move.from, to: move.to };
    sans.push(move.san);
    fens.push(game.fen());
    Board.setLastMove(lastMove);
    Board.setHint(null);
    Board.render();
    soundFor(move);
    renderMoveList();
    renderCaptured();
    renderOpening();
    updateEvalBar();
    updateStatus();
    checkGameOver();
  }

  function engineMove() {
    // never move on the player's turn — guards stray/late triggers (e.g. the
    // black-opening setTimeout firing after a new game or takeback).
    if (gameOver || !boardActive || game.turn() === playerColor) return;
    setThinking(true, 'Opponent is thinking…');
    var cfg = Difficulty.ratingToConfig(oppRating);
    var fen = game.fen();
    var mySeq = engineSeq; // if this changes (e.g. takeback), drop this move

    var stale = function () { return !boardActive || mySeq !== engineSeq; };

    var applyUci = function (uci) {
      if (stale()) { return; } // switched modes or taken back
      var move = null;
      if (uci) {
        move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
      }
      if (!move) move = randomMove(); // fallback
      setThinking(false);
      if (move) {
        commitMove(move);
      }
    };

    if (Math.random() < cfg.blunderProb) {
      // deliberate weak move — select AND apply together after a short delay so
      // the engine doesn't move instantly (and game state never desyncs).
      setTimeout(function () {
        if (stale()) return;
        var m = randomMove();
        setThinking(false);
        if (m) commitMove(m);
      }, 180);
      return;
    }

    Engine.getBestMove(fen, cfg).then(function (res) {
      applyUci(res.bestmove);
    }).catch(function () {
      applyUci(null);
    });
  }

  // Picks and applies a random legal move, returning the move object (or null).
  function randomMove() {
    var ms = game.moves({ verbose: true });
    if (!ms.length) return null;
    return game.move(ms[Math.floor(Math.random() * ms.length)]);
  }

  /* ----------------------------------------------------------- game over */
  function checkGameOver() {
    if (!game.game_over()) return;
    var score; // for the human player
    var reason;
    if (game.in_checkmate()) {
      var loser = game.turn();
      score = (loser === playerColor) ? 0 : 1;
      reason = (score === 1) ? 'Checkmate — you win!' : 'Checkmate — you lose.';
    } else {
      score = 0.5;
      if (game.in_stalemate()) reason = 'Stalemate — draw.';
      else if (game.in_threefold_repetition()) reason = 'Threefold repetition — draw.';
      else if (game.insufficient_material()) reason = 'Insufficient material — draw.';
      else reason = 'Draw.';
    }
    endGame(score, reason);
  }

  function endGame(score, reason) {
    if (gameOver) return;
    gameOver = true;
    setThinking(false);

    if (mode === 'calibration') {
      var r = Calibration.report(score);
      if (r.done) {
        profile.rating = r.rating;
        profile.calibrated = true;
        Rating.saveProfile(profile);
        mode = 'normal';
        renderProfile();
        showResult('Calibration complete', reason + '\nYour starting rating is ' + r.rating + '.', { delta: null });
      } else {
        showResult('Calibration game ' + (Calibration.totalGames() - Calibration.gamesLeft()) + ' of ' + Calibration.totalGames(),
          reason + '\nNext opponent: ' + r.nextOpponent, { calibrationNext: r.nextOpponent });
      }
      updateCalibBanner();
      return;
    }

    var change = Rating.recordGame(profile, oppRating, score);
    renderProfile();
    var sign = change.delta >= 0 ? '+' : '';
    showResult(titleFor(score), reason + '\nRating ' + change.before + ' → ' + change.after +
      ' (' + sign + change.delta + ')', { delta: change.delta });
  }

  function titleFor(score) { return score === 1 ? 'Victory' : score === 0 ? 'Defeat' : 'Draw'; }

  function resign() {
    if (gameOver || mode === 'calibration') return;
    endGame(0, 'You resigned.');
  }

  function offerDraw() {
    if (gameOver || thinking || mode === 'calibration') return;
    setThinking(true, 'Opponent considering draw…');
    Analysis.evalWhite(game.fen(), 12).then(function (e) {
      setThinking(false);
      var fromPlayer = playerColor === 'w' ? e.cp : -e.cp;
      // opponent accepts if roughly equal from its own perspective
      if (Math.abs(e.cp) <= 50) endGame(0.5, 'Draw agreed.');
      else global.alert('Opponent declined the draw.');
    }).catch(function () { setThinking(false); global.alert('Opponent declined the draw.'); });
  }

  /* ----------------------------------------------------------- help */
  function showHint() {
    if (!Settings.get('hints') || gameOver || thinking || game.turn() !== playerColor) return;
    setThinking(true, 'Finding a good move…');
    Analysis.hint(game.fen()).then(function (uci) {
      setThinking(false);
      if (uci) { Board.setHint({ from: uci.slice(0, 2), to: uci.slice(2, 4) }); }
    }).catch(function () { setThinking(false); });
  }

  function takeback() {
    if (!Settings.get('takebacks') || mode === 'calibration' || replayActive) return;
    if (sans.length === 0) return;
    // cancel any engine move currently being computed so it can't land on the
    // reverted position, and allow takeback even while it's "thinking".
    engineSeq++;
    setThinking(false);
    // undo the last ply, then keep undoing until it's the player's turn again
    // (handles both "engine just replied" -> 2 plies and "engine still thinking
    // after your move" -> 1 ply).
    game.undo(); sans.pop(); fens.pop();
    var guard = 0;
    while (sans.length > 0 && game.turn() !== playerColor && guard++ < 4) {
      game.undo(); sans.pop(); fens.pop();
    }
    gameOver = false;
    lastMove = sans.length ? deriveLastMove() : null;
    Board.setLastMove(lastMove);
    Board.setHint(null);
    Board.clearSelection();
    Board.render();
    renderMoveList(); renderCaptured(); renderOpening();
    updateEvalBar(); updateStatus();
  }

  function deriveLastMove() {
    var h = game.history({ verbose: true });
    var m = h[h.length - 1];
    return m ? { from: m.from, to: m.to } : null;
  }

  /* ----------------------------------------------------------- new game */
  function startGame(opponentRating, colorChoice, gameMode) {
    mode = gameMode || 'normal';
    engineSeq++; // invalidate any engine move still being computed
    oppRating = Difficulty.clamp(Math.round(opponentRating), 250, 2800);
    if (colorChoice === 'random') playerColor = Math.random() < 0.5 ? 'w' : 'b';
    else playerColor = colorChoice || 'w';

    game.reset();
    sans = [];
    fens = [game.fen()];
    lastMove = null;
    gameOver = false;
    replayActive = false;
    reviewData = null;
    closeReview();

    Board.setLastMove(null);
    Board.setHint(null);
    Board.setOrientation(playerColor);
    Board.clearSelection();
    Board.render();

    renderMoveList(); renderCaptured(); renderOpening();
    renderOppInfo();
    updateEvalBar(); updateStatus();
    updateCalibBanner();

    if (playerColor === 'b') {
      // engine opens
      setTimeout(engineMove, 250);
    }
  }

  function playNext() {
    var offset = parseInt($('challengeSelect').value, 10) || 0;
    var opp = Rating.matchmake(profile, offset);
    $('fineSlider').value = opp;
    $('fineSliderVal').textContent = opp;
    startGame(opp, $('colorSelect').value, 'normal');
  }

  function startCalibration() {
    var firstOpp = Calibration.start();
    profile.calibrated = false;
    startGame(firstOpp, 'random', 'calibration');
  }

  /* ----------------------------------------------------------- review */
  function runReview() {
    if (reviewData) { openReview(); return; }
    if (sans.length === 0) { global.alert('Play a game first.'); return; }
    var panel = $('reviewPanel');
    openReview();
    $('reviewAccuracy').textContent = 'Analyzing…';
    $('reviewMoves').innerHTML = '';
    Analysis.reviewGame(fens.slice(), sans.slice(), 'w', function (done, total) {
      $('reviewAccuracy').textContent = 'Analyzing… ' + done + '/' + total;
    }).then(function (data) {
      reviewData = data;
      renderReview();
      enterReplay();
    }).catch(function (e) {
      $('reviewAccuracy').textContent = 'Analysis unavailable.';
    });
  }

  function renderReview() {
    var pc = playerColor === 'w' ? reviewData.accuracy.white : reviewData.accuracy.black;
    var oc = playerColor === 'w' ? reviewData.accuracy.black : reviewData.accuracy.white;
    $('reviewAccuracy').innerHTML = 'Your accuracy: <b>' + pc + '%</b> &nbsp; · &nbsp; Opponent: ' + oc + '%';
    var html = '';
    reviewData.moves.forEach(function (m, i) {
      var num = Math.floor(i / 2) + 1;
      var prefix = (i % 2 === 0) ? (num + '.') : (num + '…');
      html += '<span class="rv rv-' + m.label.toLowerCase() + '" data-ply="' + (i + 1) + '">' +
        prefix + ' ' + m.san + ' <em>' + m.label + '</em></span>';
    });
    $('reviewMoves').innerHTML = html;
    var spans = $('reviewMoves').querySelectorAll('.rv');
    for (var i = 0; i < spans.length; i++) {
      spans[i].addEventListener('click', function () { showReplayAt(parseInt(this.dataset.ply, 10)); });
    }
  }

  function enterReplay() { replayActive = true; replayIndex = sans.length; showReplayAt(sans.length); }
  function showReplayAt(idx) {
    replayActive = true;
    replayIndex = Math.max(0, Math.min(sans.length, idx));
    replayGame.reset();
    for (var i = 0; i < replayIndex; i++) replayGame.move(sans[i]);
    var lm = null;
    if (replayIndex > 0) {
      var h = replayGame.history({ verbose: true });
      var m = h[h.length - 1];
      lm = { from: m.from, to: m.to };
    }
    Board.setLastMove(lm);
    Board.render();
    if (reviewData && reviewData.evals) {
      var cp = reviewData.evals[replayIndex];
      setEvalBar(cp);
      $('replayInfo').textContent = 'Move ' + replayIndex + ' / ' + sans.length +
        '  ·  eval ' + fmtEval(cp);
    }
  }

  function openReview() { $('reviewPanel').classList.add('open'); }
  function closeReview() {
    $('reviewPanel').classList.remove('open');
    if (replayActive) {
      replayActive = false;
      Board.setLastMove(lastMove);
      Board.render();
      updateEvalBar();
    }
  }

  /* ----------------------------------------------------------- eval bar */
  function fmtEval(cp) {
    if (cp >= 1000 - 21) return '#';
    if (cp <= -(1000 - 21)) return '-#';
    return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(1);
  }
  function setEvalBar(cp) {
    var clamped = Math.max(-800, Math.min(800, cp));
    var pct = 50 + (clamped / 800) * 50; // white share from bottom
    $('evalFill').style.height = pct + '%';
    $('evalText').textContent = fmtEval(cp);
    // keep the .eval-text class (size/position/outline); don't overwrite it
    $('evalText').className = 'eval-text';
  }
  function updateEvalBar() {
    if (!Settings.get('evalBar')) { $('evalBarWrap').style.visibility = 'hidden'; return; }
    $('evalBarWrap').style.visibility = 'visible';
    if (gameOver && game.in_checkmate()) {
      setEvalBar(game.turn() === 'w' ? -1000 : 1000);
      return;
    }
    Analysis.evalWhite(game.fen(), 11).then(function (e) { setEvalBar(e.cp); }).catch(function () {});
  }

  /* ----------------------------------------------------------- UI render */
  function setThinking(on, msg) {
    thinking = on;
    $('thinking').textContent = on ? (msg || 'Thinking…') : '';
    $('thinking').style.visibility = on ? 'visible' : 'hidden';
  }

  function updateStatus() {
    var s;
    if (gameOver) { s = ''; }
    else if (game.turn() === playerColor) s = 'Your move' + (game.in_check() ? ' — check!' : '');
    else s = 'Opponent to move' + (game.in_check() ? ' — check!' : '');
    $('status').textContent = s;
  }

  function renderMoveList() {
    var html = '';
    for (var i = 0; i < sans.length; i += 2) {
      var n = i / 2 + 1;
      html += '<div class="ml-row"><span class="ml-num">' + n + '.</span>' +
        '<span class="ml-mv">' + sans[i] + '</span>' +
        '<span class="ml-mv">' + (sans[i + 1] || '') + '</span></div>';
    }
    var el = $('moveList');
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  }

  function renderCaptured() {
    var start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    var cur = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    var b = game.board();
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var cell = b[r][c];
      if (cell && cell.type !== 'k') cur[cell.color][cell.type]++;
    }
    function capturedBy(color) { // pieces of opponent color that are missing
      var opp = color === 'w' ? 'b' : 'w';
      var out = '';
      ['q', 'r', 'b', 'n', 'p'].forEach(function (t) {
        var missing = start[t] - cur[opp][t];
        var url = 'assets/pieces/' + opp + t.toUpperCase() + '.svg';
        for (var i = 0; i < missing; i++) out += '<span class="cap" style="background-image:url(\'' + url + '\')"></span>';
      });
      return out;
    }
    $('capturedTop').innerHTML = capturedBy(playerColor === 'w' ? 'b' : 'w');
    $('capturedBottom').innerHTML = capturedBy(playerColor);
  }

  function renderOpening() {
    var name = Openings.detect(sans);
    $('openingName').textContent = name || '';
  }

  function renderOppInfo() {
    $('oppRatingVal').textContent = oppRating;
    $('oppTag').textContent = Difficulty.botLabel(oppRating);
    $('playingAs').textContent = 'You: ' + (playerColor === 'w' ? 'White' : 'Black');
  }

  function renderProfile() {
    $('ratingValue').textContent = profile.rating;
    $('myTag').textContent = Difficulty.botLabel(profile.rating);
    $('record').textContent = profile.wins + 'W · ' + profile.losses + 'L · ' + profile.draws + 'D';
    $('gamesPlayed').textContent = profile.gamesPlayed + ' games';
    renderSparkline();
  }

  function renderSparkline() {
    var pts = profile.history.slice(-40).map(function (h) { return h.rating; });
    if (pts.length < 2) { $('sparkline').innerHTML = ''; return; }
    var w = 220, h = 48, pad = 4;
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    if (max === min) { max += 1; min -= 1; }
    var step = (w - 2 * pad) / (pts.length - 1);
    var path = pts.map(function (v, i) {
      var x = pad + i * step;
      var y = pad + (1 - (v - min) / (max - min)) * (h - 2 * pad);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    $('sparkline').innerHTML =
      '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' +
      '<path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2"/></svg>' +
      '<div class="spark-range">' + min + ' – ' + max + '</div>';
  }

  function updateCalibBanner() {
    var banner = $('calibBanner');
    if (mode === 'calibration') {
      banner.style.display = 'block';
      banner.textContent = 'Calibration — game ' + Calibration.gameNumber() + ' of ' +
        Calibration.totalGames() + ' · opponent ' + oppRating;
    } else {
      banner.style.display = 'none';
    }
  }

  /* ----------------------------------------------------------- modals */
  function promptPromotion(color, cb) {
    var overlay = $('promoOverlay');
    var pieces = ['q', 'r', 'b', 'n'];
    overlay.innerHTML = '';
    pieces.forEach(function (p) {
      var btn = document.createElement('button');
      btn.className = 'promo-btn';
      btn.style.backgroundImage = "url('assets/pieces/" + color + p.toUpperCase() + ".svg')";
      btn.addEventListener('click', function () {
        overlay.classList.remove('open');
        cb(p);
      });
      overlay.appendChild(btn);
    });
    overlay.classList.add('open');
  }

  function showResult(title, text, opts) {
    $('resultTitle').textContent = title;
    $('resultText').textContent = text;
    var nextBtn = $('rmNext');
    var calBtn = $('rmCalNext');
    // restore default button visibility/labels (welcome screen may have changed them)
    $('rmReview').style.display = '';
    $('rmClose').style.display = '';
    $('rmClose').textContent = 'Close';
    calBtn.textContent = 'Next placement game';
    if (opts && opts.calibrationNext) {
      calBtn.style.display = '';
      nextBtn.style.display = 'none';
      $('rmReview').style.display = 'none';
      calBtn.onclick = function () {
        $('resultModal').classList.remove('open');
        startGame(opts.calibrationNext, 'random', 'calibration');
      };
    } else {
      calBtn.style.display = 'none';
      nextBtn.style.display = '';
    }
    $('resultModal').classList.add('open');
  }

  /* ----------------------------------------------------------- settings UI */
  function applyTheme() {
    document.body.setAttribute('data-theme', Settings.get('theme'));
    document.body.classList.toggle('dark', !!Settings.get('dark'));
  }

  function bindSettings() {
    var toggles = ['hints', 'evalBar', 'takebacks', 'blunderWarning', 'sounds', 'legalDots'];
    toggles.forEach(function (key) {
      var el = $('set-' + key);
      el.checked = Settings.get(key);
      el.addEventListener('change', function () {
        Settings.set(key, el.checked);
        applyFeatureVisibility();
        if (key === 'evalBar') updateEvalBar();
      });
    });
    var theme = $('set-theme');
    theme.value = Settings.get('theme');
    theme.addEventListener('change', function () { Settings.set('theme', theme.value); applyTheme(); });
    var dark = $('set-dark');
    dark.checked = Settings.get('dark');
    dark.addEventListener('change', function () { Settings.set('dark', dark.checked); applyTheme(); });

    $('recalibrateBtn').addEventListener('click', function () {
      if (global.confirm('Recalibrate your rating with a fresh set of placement games?')) {
        closePanel(); startCalibration();
      }
    });
    $('resetProfileBtn').addEventListener('click', function () {
      if (global.confirm('Erase your profile, rating and history? This cannot be undone.')) {
        profile = Rating.resetProfile();
        renderProfile();
        closePanel();
        startCalibration();
      }
    });
  }

  function applyFeatureVisibility() {
    $('hintBtn').style.display = Settings.get('hints') ? '' : 'none';
    $('undoBtn').style.display = Settings.get('takebacks') ? '' : 'none';
    $('evalBarWrap').style.display = Settings.get('evalBar') ? '' : 'none';
  }

  function openPanel() { $('settingsPanel').classList.add('open'); }
  function closePanel() { $('settingsPanel').classList.remove('open'); }

  /* ----------------------------------------------------------- mode switch */
  function enterPuzzleMode() {
    if (Puzzles.isActive()) return;
    boardActive = false;
    setThinking(false);
    document.body.classList.add('mode-puzzle');
    $('tabPuzzles').classList.add('active');
    $('tabPlay').classList.remove('active');
    Board.setOpts(Puzzles.boardOpts);
    Puzzles.enter();
  }
  function enterPlayMode() {
    if (!Puzzles.isActive()) return;
    Puzzles.exit();
    boardActive = true;
    document.body.classList.remove('mode-puzzle');
    $('tabPlay').classList.add('active');
    $('tabPuzzles').classList.remove('active');
    Board.setOpts(boardOpts);
    Board.setOrientation(playerColor);
    Board.setLastMove(lastMove);
    Board.setHint(null);
    Board.render();
    updateEvalBar();
    if (!gameOver && game.turn() !== playerColor) engineMove();
  }

  /* ----------------------------------------------------------- wire up */
  function bind() {
    Board.init($('board'), boardOpts);
    Puzzles.bind();
    bindSettings();
    applyTheme();
    applyFeatureVisibility();

    $('tabPlay').addEventListener('click', enterPlayMode);
    $('tabPuzzles').addEventListener('click', enterPuzzleMode);

    $('playNext').addEventListener('click', playNext);
    $('newGameBtn').addEventListener('click', function () {
      startGame(parseInt($('fineSlider').value, 10), $('colorSelect').value, 'normal');
    });
    $('fineSlider').addEventListener('input', function () {
      $('fineSliderVal').textContent = this.value;
    });
    $('hintBtn').addEventListener('click', showHint);
    $('undoBtn').addEventListener('click', takeback);
    $('flipBtn').addEventListener('click', function () { Board.flip(); });
    $('resignBtn').addEventListener('click', resign);
    $('drawBtn').addEventListener('click', offerDraw);
    $('reviewBtn').addEventListener('click', runReview);

    $('settingsBtn').addEventListener('click', openPanel);
    $('panelClose').addEventListener('click', closePanel);
    $('reviewClose').addEventListener('click', closeReview);
    $('replayPrev').addEventListener('click', function () { showReplayAt(replayIndex - 1); });
    $('replayNext').addEventListener('click', function () { showReplayAt(replayIndex + 1); });
    $('replayStart').addEventListener('click', function () { showReplayAt(0); });
    $('replayEnd').addEventListener('click', function () { showReplayAt(sans.length); });

    $('rmReview').addEventListener('click', function () { $('resultModal').classList.remove('open'); runReview(); });
    $('rmNext').addEventListener('click', function () { $('resultModal').classList.remove('open'); playNext(); });
    $('rmClose').addEventListener('click', function () { $('resultModal').classList.remove('open'); });

    renderProfile();

    // engine status
    if (Engine.error()) {
      $('status').textContent = 'Engine failed to load (check your connection).';
    } else {
      Engine.whenReady(function () { updateEvalBar(); });
      Engine.init();
    }

    // render a playable board behind everything
    startGame(Rating.matchmake(profile, 0), 'random', 'normal');

    // first run → offer placement (closing the modal just leaves a casual game)
    if (!profile.calibrated) {
      $('resultTitle').textContent = 'Welcome';
      $('resultText').textContent = 'Let\'s find your level. You\'ll play 4 quick placement ' +
        'games; the opponent adapts to your results, then your starting rating is set. ' +
        'You can skip and just play, then calibrate later from Settings.';
      $('rmReview').style.display = 'none';
      $('rmNext').style.display = 'none';
      $('rmCalNext').style.display = '';
      $('rmCalNext').textContent = 'Start placement (4 games)';
      $('rmCalNext').onclick = function () { $('resultModal').classList.remove('open'); startCalibration(); };
      $('rmClose').textContent = 'Skip for now';
      $('rmClose').style.display = '';
      $('resultModal').classList.add('open');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  global.GameApp = {
    startGame: startGame,
    profile: function () { return profile; },
    // lightweight introspection hooks (used for testing / debugging in console)
    _debug: {
      move: onPlayerMove,
      fen: function () { return game.fen(); },
      turn: function () { return game.turn(); },
      playerColor: function () { return playerColor; },
      isOver: function () { return gameOver; },
      mode: function () { return mode; },
      oppRating: function () { return oppRating; }
    }
  };
})(window);
