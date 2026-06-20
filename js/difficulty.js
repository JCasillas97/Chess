/*
 * difficulty.js
 * Maps a chess.com-equivalent rating (250-2800) onto Stockfish engine
 * configuration. Below ~1350 Stockfish's UCI_Elo can't reach, so we lean on
 * a low Skill Level, a shallow search depth and a probabilistic blunder model
 * (handled by game.js using `blunderProb`). Above that we use UCI_LimitStrength.
 */
(function (global) {
  'use strict';

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Returns { options:{}, go:'depth X movetime Y', blunderProb:0..1 }
  function ratingToConfig(rating) {
    rating = clamp(Math.round(rating), 250, 2800);
    var options = { 'MultiPV': 1 };
    var depth, blunderProb;

    if (rating < 800) {
      var t0 = (rating - 250) / (800 - 250);          // 0..1
      options['UCI_LimitStrength'] = 'false';
      options['Skill Level'] = 0;
      depth = Math.round(lerp(1, 3, t0));
      blunderProb = lerp(0.45, 0.20, t0);
    } else if (rating < 1350) {
      var t1 = (rating - 800) / (1350 - 800);
      options['UCI_LimitStrength'] = 'false';
      options['Skill Level'] = Math.round(lerp(1, 8, t1));
      depth = Math.round(lerp(4, 8, t1));
      blunderProb = lerp(0.20, 0.05, t1);
    } else {
      var t2 = (rating - 1350) / (2800 - 1350);
      options['UCI_LimitStrength'] = 'true';
      options['UCI_Elo'] = Math.round(clamp(rating, 1350, 2850));
      options['Skill Level'] = 20;
      depth = Math.round(lerp(8, 16, t2));
      blunderProb = 0;
    }

    var movetime = Math.round(lerp(250, 700, clamp((rating - 250) / 2550, 0, 1)));
    return {
      options: options,
      go: 'depth ' + depth + ' movetime ' + movetime,
      blunderProb: blunderProb
    };
  }

  // Friendly persona tag shown next to the rating number.
  function botLabel(rating) {
    rating = Math.round(rating);
    if (rating < 500) return 'Novice';
    if (rating < 800) return 'Beginner';
    if (rating < 1100) return 'Casual';
    if (rating < 1400) return 'Improver';
    if (rating < 1700) return 'Club Player';
    if (rating < 2000) return 'Strong Club';
    if (rating < 2300) return 'Expert';
    if (rating < 2500) return 'Master';
    return 'Grandmaster';
  }

  global.Difficulty = { ratingToConfig: ratingToConfig, botLabel: botLabel, clamp: clamp };
})(window);
