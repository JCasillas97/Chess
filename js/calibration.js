/*
 * calibration.js
 * Adaptive placement. Plays a short series of games; after each, the test
 * rating moves up on a win / down on a loss with a shrinking step, converging
 * toward the level where the user scores ~50%. The final value seeds the
 * profile rating. game.js drives the games and reports results here.
 */
(function (global) {
  'use strict';

  var GAMES = 4;
  var START = 1000;
  var FIRST_STEP = 450;

  var state = null;

  function start() {
    state = { rating: START, step: FIRST_STEP, played: 0, results: [] };
    return state.rating;
  }

  function current() { return state ? state.rating : START; }
  function gamesLeft() { return state ? (GAMES - state.played) : GAMES; }
  function gameNumber() { return state ? state.played + 1 : 1; }
  function totalGames() { return GAMES; }
  function isActive() { return !!state; }

  // score: 1 win, 0.5 draw, 0 loss. Returns { done, rating, nextOpponent }.
  function report(score) {
    if (!state) return { done: true, rating: START };
    state.results.push({ opp: state.rating, score: score });
    state.played++;

    if (score === 1) state.rating += state.step;
    else if (score === 0) state.rating -= state.step;
    else state.rating += Math.round(state.step * 0.15); // small nudge up on a draw

    state.rating = Math.max(250, Math.min(2800, state.rating));
    state.step = Math.max(60, Math.round(state.step * 0.55));

    if (state.played >= GAMES) {
      var finalRating = state.rating;
      var done = { done: true, rating: finalRating };
      state = null;
      return done;
    }
    return { done: false, rating: state.rating, nextOpponent: state.rating };
  }

  function cancel() { state = null; }

  global.Calibration = {
    start: start,
    report: report,
    current: current,
    gamesLeft: gamesLeft,
    gameNumber: gameNumber,
    totalGames: totalGames,
    isActive: isActive,
    cancel: cancel
  };
})(window);
