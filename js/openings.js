/*
 * openings.js
 * Compact opening detector. Matches the longest leading SAN sequence of the
 * game against a small ECO table and returns the opening name.
 */
(function (global) {
  'use strict';

  // key = space-joined SAN moves, value = opening name
  var BOOK = {
    'e4': 'King\'s Pawn Opening',
    'e4 e5': 'Open Game',
    'e4 e5 Nf3': 'King\'s Knight Opening',
    'e4 e5 Nf3 Nc6': 'King\'s Knight, Normal',
    'e4 e5 Nf3 Nc6 Bb5': 'Ruy Lopez',
    'e4 e5 Nf3 Nc6 Bb5 a6': 'Ruy Lopez, Morphy Defense',
    'e4 e5 Nf3 Nc6 Bc4': 'Italian Game',
    'e4 e5 Nf3 Nc6 Bc4 Bc5': 'Italian Game, Giuoco Piano',
    'e4 e5 Nf3 Nc6 Bc4 Nf6': 'Italian Game, Two Knights Defense',
    'e4 e5 Nf3 Nc6 d4': 'Scotch Game',
    'e4 e5 Nf3 Nf6': 'Petrov\'s Defense',
    'e4 e5 Nc3': 'Vienna Game',
    'e4 e5 Bc4': 'Bishop\'s Opening',
    'e4 e5 f4': 'King\'s Gambit',
    'e4 c5': 'Sicilian Defense',
    'e4 c5 Nf3': 'Sicilian Defense',
    'e4 c5 Nf3 d6': 'Sicilian, Najdorf Setup',
    'e4 c5 Nf3 Nc6': 'Sicilian, Old Sicilian',
    'e4 c5 Nf3 e6': 'Sicilian, French Variation',
    'e4 c5 Nc3': 'Sicilian, Closed',
    'e4 e6': 'French Defense',
    'e4 e6 d4 d5': 'French Defense, Main Line',
    'e4 c6': 'Caro-Kann Defense',
    'e4 c6 d4 d5': 'Caro-Kann, Main Line',
    'e4 d5': 'Scandinavian Defense',
    'e4 d6': 'Pirc Defense',
    'e4 g6': 'Modern Defense',
    'e4 Nf6': 'Alekhine\'s Defense',
    'd4': 'Queen\'s Pawn Opening',
    'd4 d5': 'Closed Game',
    'd4 d5 c4': 'Queen\'s Gambit',
    'd4 d5 c4 e6': 'Queen\'s Gambit Declined',
    'd4 d5 c4 c6': 'Slav Defense',
    'd4 d5 c4 dxc4': 'Queen\'s Gambit Accepted',
    'd4 Nf6': 'Indian Defense',
    'd4 Nf6 c4': 'Indian Game',
    'd4 Nf6 c4 e6': 'Indian, Nimzo/Queen\'s Indian Complex',
    'd4 Nf6 c4 e6 Nc3 Bb4': 'Nimzo-Indian Defense',
    'd4 Nf6 c4 g6': 'King\'s Indian / Grünfeld Complex',
    'd4 Nf6 c4 g6 Nc3 Bg7': 'King\'s Indian Defense',
    'd4 Nf6 c4 g6 Nc3 d5': 'Grünfeld Defense',
    'd4 Nf6 c4 c5': 'Benoni Defense',
    'd4 f5': 'Dutch Defense',
    'c4': 'English Opening',
    'c4 e5': 'English, Reversed Sicilian',
    'c4 c5': 'English, Symmetrical',
    'Nf3': 'Réti Opening',
    'Nf3 d5 g3': 'Réti / King\'s Indian Attack',
    'g3': 'Hungarian Opening',
    'b3': 'Nimzo-Larsen Attack',
    'f4': 'Bird\'s Opening',
    'b4': 'Polish (Sokolsky) Opening'
  };

  // history: array of SAN strings. Returns the most specific opening name or null.
  function detect(history) {
    if (!history || !history.length) return null;
    var best = null;
    for (var len = Math.min(history.length, 8); len >= 1; len--) {
      var key = history.slice(0, len).join(' ');
      if (BOOK[key]) { best = BOOK[key]; break; }
    }
    return best;
  }

  global.Openings = { detect: detect };
})(window);
