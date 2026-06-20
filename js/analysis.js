/*
 * analysis.js
 * Full-strength evaluation helpers built on Engine.analyze:
 *   - eval (white perspective) for the eval bar
 *   - hint (best move)
 *   - blunder check (centipawn loss of an intended move)
 *   - full game review: per-move labels + accuracy %, plus an eval timeline
 *     used by the replay stepper.
 */
(function (global) {
  'use strict';

  var MATE_CP = 1000; // cap mate scores for math

  function sideToMove(fen) { return fen.split(' ')[1] || 'w'; }

  // Convert an engine score {type,value} (from side-to-move POV) to centipawns
  // from White's perspective.
  function toWhiteCp(score, fen) {
    if (!score) return 0;
    var cp;
    if (score.type === 'mate') {
      cp = (score.value >= 0 ? 1 : -1) * (MATE_CP - Math.min(Math.abs(score.value), 20));
    } else {
      cp = score.value;
    }
    return sideToMove(fen) === 'w' ? cp : -cp;
  }

  function evalWhite(fen, depth) {
    return Engine.analyze(fen, { depth: depth || 12 }).then(function (r) {
      return { cp: toWhiteCp(r.info, fen), info: r.info, bestmove: r.bestmove };
    });
  }

  function hint(fen, depth) {
    return Engine.analyze(fen, { depth: depth || 14 }).then(function (r) {
      return r.bestmove; // uci string like "e2e4"
    });
  }

  // Win probability for White, from centipawns (chess.com-style logistic).
  function winPercent(cpWhite) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cpWhite)) - 1);
  }

  // Per-move accuracy from the drop in win% for the mover.
  function moveAccuracy(winBeforeMover, winAfterMover) {
    var drop = winBeforeMover - winAfterMover;
    var acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
    return Math.max(0, Math.min(100, acc));
  }

  function classify(cploss) {
    if (cploss <= 10) return 'Best';
    if (cploss <= 40) return 'Good';
    if (cploss <= 90) return 'Inaccuracy';
    if (cploss <= 200) return 'Mistake';
    return 'Blunder';
  }

  // Quick blunder check for a candidate move that has already been pushed onto a
  // temporary chess.js game (so we can read fenBefore and fenAfter). Returns the
  // centipawn loss for the mover.
  function moveCpLoss(fenBefore, fenAfter, moverColor) {
    return Promise.all([evalWhite(fenBefore, 12), evalWhite(fenAfter, 12)])
      .then(function (res) {
        var before = res[0].cp, after = res[1].cp;
        var loss = (moverColor === 'w') ? (before - after) : (after - before);
        return Math.max(0, loss);
      });
  }

  /*
   * reviewGame: fens is the list of positions AFTER each ply, with fens[0] being
   * the start position (so length = plies + 1). sans is the SAN list (length =
   * plies). firstMover is 'w' or 'b' (color that made sans[0]).
   * Calls onProgress(done, total) as it analyzes.
   * Returns { evals:[cpWhite per position], moves:[{san,color,cploss,label}], accuracy:{white,black} }
   */
  function reviewGame(fens, sans, firstMover, onProgress) {
    var evals = new Array(fens.length);
    var i = 0;

    function step() {
      if (i >= fens.length) return Promise.resolve();
      return evalWhite(fens[i], 12).then(function (e) {
        evals[i] = e.cp;
        if (onProgress) onProgress(i + 1, fens.length);
        i++;
        return step();
      });
    }

    return step().then(function () {
      var moves = [];
      var accW = [], accB = [];
      for (var k = 0; k < sans.length; k++) {
        var color = (k % 2 === 0) ? firstMover : (firstMover === 'w' ? 'b' : 'w');
        var beforeW = evals[k];
        var afterW = evals[k + 1];
        var cploss = (color === 'w') ? (beforeW - afterW) : (afterW - beforeW);
        cploss = Math.max(0, cploss);

        var wBefore = winPercent(beforeW);
        var wAfter = winPercent(afterW);
        var moverBefore = (color === 'w') ? wBefore : (100 - wBefore);
        var moverAfter = (color === 'w') ? wAfter : (100 - wAfter);
        var acc = moveAccuracy(moverBefore, moverAfter);

        if (color === 'w') accW.push(acc); else accB.push(acc);
        moves.push({ san: sans[k], color: color, cploss: Math.round(cploss), label: classify(cploss) });
      }
      function avg(a) { return a.length ? Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : 100; }
      return { evals: evals, moves: moves, accuracy: { white: avg(accW), black: avg(accB) } };
    });
  }

  global.Analysis = {
    evalWhite: evalWhite,
    hint: hint,
    moveCpLoss: moveCpLoss,
    reviewGame: reviewGame,
    winPercent: winPercent,
    classify: classify,
    toWhiteCp: toWhiteCp
  };
})(window);
