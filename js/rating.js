/*
 * rating.js
 * Persistent single-user profile + Elo math + opponent matchmaking.
 * Stored client-side in localStorage. The rating self-tunes from real game
 * results with a small K, so progress is gradual (chess.com-style, vs bots).
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'chessPracticeProfile.v1';
  var K_CALIBRATION = 40; // large swings while placing
  var K_NORMAL = 18;      // small, gradual swings afterwards

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function defaultProfile() {
    return {
      rating: 800,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      history: [],        // [{ rating, opp, score, date }]
      calibrated: false,
      // puzzle mode (independent rating that adapts as you solve/fail)
      puzzleRating: 800,
      puzzlesSolved: 0,
      puzzlesFailed: 0,
      puzzleHistory: [],  // [{ rating, puzzle, score, date }]
      puzzleSeen: []      // recently shown puzzle ids (to avoid repeats)
    };
  }

  function loadProfile() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultProfile();
      var p = JSON.parse(raw);
      var d = defaultProfile();
      // merge to tolerate older/missing fields
      for (var k in d) { if (!(k in p)) p[k] = d[k]; }
      return p;
    } catch (e) {
      return defaultProfile();
    }
  }

  function saveProfile(p) {
    try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }
    catch (e) { /* storage may be unavailable; ignore */ }
  }

  function resetProfile() {
    try { global.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    return defaultProfile();
  }

  // Expected score for player vs opponent (0..1).
  function expectedScore(player, opp) {
    return 1 / (1 + Math.pow(10, (opp - player) / 400));
  }

  // Returns new rating after a game. score in {1, 0.5, 0}.
  function newRating(player, opp, score, K) {
    return Math.round(player + K * (score - expectedScore(player, opp)));
  }

  // Records a completed (non-calibration) game and mutates the profile.
  function recordGame(profile, oppRating, score) {
    var before = profile.rating;
    profile.rating = clamp(newRating(before, oppRating, score, K_NORMAL), 100, 3000);
    if (score === 1) profile.wins++;
    else if (score === 0) profile.losses++;
    else profile.draws++;
    profile.gamesPlayed++;
    profile.history.push({
      rating: profile.rating,
      opp: oppRating,
      score: score,
      date: Date.now()
    });
    // keep history bounded
    if (profile.history.length > 500) profile.history = profile.history.slice(-500);
    saveProfile(profile);
    return { before: before, after: profile.rating, delta: profile.rating - before };
  }

  // Pick an opponent near the player's current rating (small offset + jitter).
  // offset: 0 = even, 30 = slight stretch, 75 = push me.
  function matchmake(profile, offset) {
    var jitter = Math.round((Math.random() - 0.5) * 30); // +/-15
    return clamp(Math.round(profile.rating + (offset || 0) + jitter), 250, 2800);
  }

  // Records a solved (score 1) or failed (score 0) puzzle and updates the
  // independent puzzle rating, so puzzles get harder as you improve.
  var K_PUZZLE = 24;
  function recordPuzzle(profile, puzzleRating, score) {
    var before = profile.puzzleRating;
    profile.puzzleRating = clamp(newRating(before, puzzleRating, score, K_PUZZLE), 100, 3200);
    if (score === 1) profile.puzzlesSolved++; else profile.puzzlesFailed++;
    profile.puzzleHistory.push({
      rating: profile.puzzleRating, puzzle: puzzleRating, score: score, date: Date.now()
    });
    if (profile.puzzleHistory.length > 500) profile.puzzleHistory = profile.puzzleHistory.slice(-500);
    saveProfile(profile);
    return { before: before, after: profile.puzzleRating, delta: profile.puzzleRating - before };
  }

  global.Rating = {
    loadProfile: loadProfile,
    saveProfile: saveProfile,
    resetProfile: resetProfile,
    defaultProfile: defaultProfile,
    expectedScore: expectedScore,
    newRating: newRating,
    recordGame: recordGame,
    matchmake: matchmake,
    recordPuzzle: recordPuzzle,
    K_CALIBRATION: K_CALIBRATION,
    K_NORMAL: K_NORMAL,
    K_PUZZLE: K_PUZZLE
  };
})(window);
