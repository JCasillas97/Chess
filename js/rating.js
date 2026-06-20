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
      calibrated: false
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

  global.Rating = {
    loadProfile: loadProfile,
    saveProfile: saveProfile,
    resetProfile: resetProfile,
    defaultProfile: defaultProfile,
    expectedScore: expectedScore,
    newRating: newRating,
    recordGame: recordGame,
    matchmake: matchmake,
    K_CALIBRATION: K_CALIBRATION,
    K_NORMAL: K_NORMAL
  };
})(window);
