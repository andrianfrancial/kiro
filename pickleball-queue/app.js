/* Pickleball Queue — vanilla JS, no build.
 * Open-play court manager: players wait in a queue, get assigned to open
 * courts (doubles = 4, singles = 2), and when a game finishes all its
 * players go to the back of the queue.
 * State persists in localStorage.
 */

(function () {
  'use strict';

  var STORE_KEY = 'pickleballQueue.state.v1';

  // ---- State ----------------------------------------------------------
  // players in queue: [{ id, name, wins, losses }]
  // courts: [{ id, players: [player], startedAt: number|null }]
  // history: [{ time, winners:[names], losers:[names] }] (most recent first)
  var state = {
    queue: [],
    challengeQueue: [], // separate line waiting for the challenge court
    courts: [],
    history: [],
    checkedOut: [], // players who have left: {..., timeIn, timeOut}
    // Current holders' win streak on the challenge court (Court 1). `ids` is
    // the sorted winner id list that owns the streak; count is wins in a row.
    challengeStreak: { ids: [], names: [], count: 0 },
    // Log of 3-in-a-row milestones: [{ time, names:[...], count }].
    challengeReports: [],
    // Recent raffle draws: [{ time, name, level, prize }] (most recent first).
    raffleHistory: [],
    // Prizes a raffle winner can receive: [{ id, label }].
    prizes: [],
    singles: false,
    balance: true,
    autoStart: true,
    skillBalance: true,
    nextId: 1
  };

  function playersPerCourt() {
    return state.singles ? 2 : 4;
  }

  // ---- Persistence ----------------------------------------------------
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      /* storage full or unavailable — app still works in-memory */
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.queue) && Array.isArray(parsed.courts)) {
        state = parsed;
        if (typeof state.nextId !== 'number') state.nextId = 1;
        if (typeof state.singles !== 'boolean') state.singles = false;
        if (typeof state.balance !== 'boolean') state.balance = true;
        if (typeof state.autoStart !== 'boolean') state.autoStart = true;
        if (typeof state.skillBalance !== 'boolean') state.skillBalance = true;
        if (!Array.isArray(state.history)) state.history = [];
        if (!Array.isArray(state.checkedOut)) state.checkedOut = [];
        if (!Array.isArray(state.challengeQueue)) state.challengeQueue = [];
        if (!Array.isArray(state.challengeReports)) state.challengeReports = [];
        if (!Array.isArray(state.raffleHistory)) state.raffleHistory = [];
        if (!Array.isArray(state.prizes)) state.prizes = [];
        if (!state.challengeStreak || !Array.isArray(state.challengeStreak.ids)) {
          state.challengeStreak = { ids: [], names: [], count: 0 };
        }
        // Migrate older saved players that lack win/loss counters, and
        // ensure every court has a score object.
        var now = Date.now();
        state.queue.forEach(function (p) {
          ensureRecord(p);
          // Older saved players lack a wait timestamp; start it now.
          if (typeof p.waitingSince !== 'number') p.waitingSince = now;
        });
        state.challengeQueue.forEach(function (p) {
          ensureRecord(p);
          if (typeof p.waitingSince !== 'number') p.waitingSince = now;
        });
        state.courts.forEach(function (c) {
          (c.players || []).forEach(ensureRecord);
          ensureScore(c);
          // Older saves: infer whether an in-play Court 1 is a challenge game.
          if (typeof c.challengeGame !== 'boolean') {
            c.challengeGame = state.courts[0] === c && c.players.length > 0;
          }
        });
        return true;
      }
    } catch (e) {}
    return false;
  }

  function newId() {
    return state.nextId++;
  }

  function ensureRecord(p) {
    if (typeof p.wins !== 'number') p.wins = 0;
    if (typeof p.losses !== 'number') p.losses = 0;
    // Games played. Migrate older data: derive from wins+losses if missing.
    if (typeof p.games !== 'number') p.games = (p.wins || 0) + (p.losses || 0);
    if (typeof p.partnerId === 'undefined') p.partnerId = null;
    // Arrival time for attendance. Older data: default to now.
    if (typeof p.timeIn !== 'number') p.timeIn = Date.now();
    // Skill level. Older data: default to intermediate.
    if (['novice', 'intermediate', 'advanced'].indexOf(p.level) === -1) {
      p.level = 'intermediate';
    }
    return p;
  }

  // Ensure a court has a score object { a, b }.
  function ensureScore(court) {
    if (!court.score || typeof court.score.a !== 'number') {
      court.score = { a: 0, b: 0 };
    }
    return court;
  }

  // Fisher–Yates shuffle (returns a new array, does not mutate input).
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  // Transient UI state (not persisted): id of the court currently being
  // edited via the inline lineup editor, or null.
  var editingCourtId = null;

  // Transient: when the user clicks 🤝 on a player to start pairing, we hold
  // that player's id here until they click 🤝 on a second player.
  var pendingPartnerId = null;

  // Transient: which on-court player is currently showing the swap picker,
  // as { courtId, playerId } or null.
  var swappingSlot = null;

  // Transient: the latest 3-in-a-row milestone to flash as a banner, as
  // { names:[...], count } or null. Cleared when dismissed or on next render
  // cycle after being shown.
  var challengeFlash = null;

  // Transient: the most recent raffle result to highlight, as
  // { player, prize } (prize may be '') or null. Not persisted.
  var raffleWinner = null;

  // Transient: raffle draw animation state. While drawing we flash random
  // names for ~5s before locking in the real winner.
  //   { name: <string shown now> } or null when idle.
  var raffleDrawing = null;
  var raffleTimers = { cycle: null, reveal: null };

  // ---- DOM refs -------------------------------------------------------
  var el = {};
  function cacheDom() {
    [
      'singlesToggle', 'balanceToggle', 'autoStartToggle', 'skillBalanceToggle', 'resetBtn',
      'queueCount', 'shuffleQueueBtn', 'addForm', 'playerName', 'playerLevel', 'queueList', 'queueEmpty',
      'challengeCount', 'shuffleChallengeBtn', 'challengeForm', 'challengeName', 'challengeLevel',
      'challengeList', 'challengeEmpty',
      'rafflePool', 'raffleDrawBtn', 'raffleClearBtn', 'raffleWinner', 'raffleEmpty', 'raffleHistory',
      'prizeCount', 'prizeForm', 'prizeName', 'prizeList', 'prizeEmpty',
      'removeCourtBtn', 'courtCount', 'addCourtBtn', 'courtsGrid',
      'challengeBanner', 'challengeBannerDismiss',
      'challengeStreakNow', 'challengeReportList', 'challengeReportEmpty',
      'statusMeta', 'standingsList', 'standingsEmpty', 'historyList',
      'historyEmpty', 'checkedOutCount', 'checkedOutList', 'checkedOutEmpty'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  // ---- Utilities ------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function firstOpenCourt() {
    for (var i = 0; i < state.courts.length; i++) {
      if (state.courts[i].players.length === 0) return state.courts[i];
    }
    return null;
  }

  // Court 1 (the first court) is the POSITION designated as the challenge
  // court. Whether it actually runs challenge rules depends on challenge
  // activity — see playsAsChallenge below.
  function isChallengeCourt(court) {
    return !!court && state.courts.length > 0 && state.courts[0].id === court.id;
  }

  // Whether a court's CURRENT game is played under challenge (king-of-the-
  // court) rules. The challenge court only runs challenge rules while a
  // challenge game is active — i.e. its lineup was drawn from the challenge
  // queue (court.challengeGame === true, set at fill time). When the
  // challenge queue is empty it falls back to a normal main-queue court, so
  // the challenge court is effectively DISABLED and plays the main queue.
  // An OPEN challenge court is considered "challenge" only if challengers are
  // actually waiting; otherwise it will fill from the main queue as normal.
  function playsAsChallenge(court) {
    if (!isChallengeCourt(court)) return false;
    if (court.players.length > 0) return court.challengeGame === true;
    return state.challengeQueue.length > 0; // open: challengers waiting?
  }

  function anyOpenCourt() {
    return firstOpenCourt() !== null;
  }

  // Is there an open court that draws from the MAIN queue? (any open court
  // other than the challenge court).
  function anyOpenMainCourt() {
    for (var i = 0; i < state.courts.length; i++) {
      var c = state.courts[i];
      if (c.players.length === 0 && !isChallengeCourt(c)) return true;
    }
    return false;
  }

  // Is the challenge court (Court 1) currently open?
  function challengeCourtOpen() {
    var c = state.courts[0];
    return !!c && c.players.length === 0;
  }

  // Resolve which waiting line a court should pull `need` players from.
  // Normal courts always use the main queue. The challenge court prefers the
  // challenge queue, but falls back to the MAIN queue when the challenge
  // queue can't supply `need` players (e.g. it's empty). Returns an object
  // { kind: 'challenge'|'main', list: <array> }.
  function fillSourceFor(court, need) {
    if (isChallengeCourt(court) && state.challengeQueue.length >= need) {
      return { kind: 'challenge', list: state.challengeQueue };
    }
    return { kind: 'main', list: state.queue };
  }

  // Write a (filtered) array back to whichever queue a fill source points at.
  function setSourceList(kind, list) {
    if (kind === 'challenge') state.challengeQueue = list;
    else state.queue = list;
  }

  // A stable key for a set of winners, so we can tell whether the SAME team
  // is still holding the challenge court (order-independent).
  function teamKey(players) {
    return players
      .map(function (p) { return p.id; })
      .sort(function (a, b) { return a - b; })
      .join('-');
  }

  // Clear the challenge-court win streak (holders changed or court cleared).
  function resetChallengeStreak() {
    state.challengeStreak = { ids: [], names: [], count: 0 };
  }

  // Push a player onto the queue, stamping when their wait (re)started.
  function enqueue(player) {
    player.waitingSince = Date.now();
    state.queue.push(player);
  }

  // ---- Actions --------------------------------------------------------
  function addPlayer(name, level) {
    var trimmed = name.trim();
    if (!trimmed) return;
    var lvl = ['novice', 'intermediate', 'advanced'].indexOf(level) !== -1
      ? level : 'intermediate';
    enqueue({
      id: newId(), name: trimmed, wins: 0, losses: 0, games: 0,
      partnerId: null, timeIn: Date.now(), level: lvl
    });
    save();
    render();
  }

  function shuffleQueue() {
    if (state.queue.length < 2) return;
    state.queue = shuffle(state.queue);
    save();
    render();
  }

  // ---- Challenge court queue -----------------------------------------
  // A separate waiting line for the challenge court. Players added here (or
  // moved over from the main queue) wait their turn as challengers.

  // Push a player onto the challenge queue, re-stamping their wait time.
  function enqueueChallenge(player) {
    player.waitingSince = Date.now();
    state.challengeQueue.push(player);
  }

  function addChallenger(name, level) {
    var trimmed = name.trim();
    if (!trimmed) return;
    var lvl = ['novice', 'intermediate', 'advanced'].indexOf(level) !== -1
      ? level : 'intermediate';
    enqueueChallenge({
      id: newId(), name: trimmed, wins: 0, losses: 0, games: 0,
      partnerId: null, timeIn: Date.now(), level: lvl
    });
    save();
    render();
  }

  function shuffleChallengeQueue() {
    if (state.challengeQueue.length < 2) return;
    state.challengeQueue = shuffle(state.challengeQueue);
    save();
    render();
  }

  function removeFromChallenge(id) {
    var leaving = findPlayer(id);
    if (leaving) clearPartner(leaving);
    if (pendingPartnerId === id) pendingPartnerId = null;
    state.challengeQueue = state.challengeQueue.filter(function (p) {
      return p.id !== id;
    });
    save();
    render();
  }

  // Move a player from the main waiting queue into the challenge queue.
  function moveToChallenge(id) {
    var idx = -1;
    for (var i = 0; i < state.queue.length; i++) {
      if (state.queue[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;
    var player = state.queue.splice(idx, 1)[0];
    enqueueChallenge(player);
    save();
    render();
  }

  // ---- Raffle ---------------------------------------------------------
  // Everyone eligible for the raffle: all players waiting in the main queue
  // plus the challenge queue (de-duped by id, just in case).
  function rafflePool() {
    var pool = [];
    var seen = {};
    state.queue.concat(state.challengeQueue).forEach(function (p) {
      if (!seen[p.id]) { seen[p.id] = true; pool.push(p); }
    });
    return pool;
  }

  var RAFFLE_SUSPENSE_MS = 5000;

  // Draw one random winner (and a random prize). Runs a 5-second suspense
  // animation — flashing random names — before revealing and logging the
  // real winner. Does NOT change any queue.
  function drawRaffle() {
    if (raffleDrawing) return; // a draw is already in progress
    var pool = rafflePool();
    if (!pool.length) {
      window.alert('No players in the main or challenge queue to raffle.');
      return;
    }

    // Decide the real winner and prize up front (hidden until reveal).
    var winner = pool[Math.floor(Math.random() * pool.length)];
    var prize = state.prizes.length
      ? state.prizes[Math.floor(Math.random() * state.prizes.length)].label
      : '';

    // Enter the drawing state: clear any previous winner highlight and flash
    // random candidate names until the reveal fires.
    raffleWinner = null;
    raffleDrawing = { name: winner.name };
    render();

    raffleTimers.cycle = setInterval(function () {
      var p = pool[Math.floor(Math.random() * pool.length)];
      raffleDrawing = { name: p.name };
      renderRaffle(); // light update of just the raffle section
    }, 90);

    raffleTimers.reveal = setTimeout(function () {
      clearInterval(raffleTimers.cycle);
      raffleTimers.cycle = null;
      raffleTimers.reveal = null;
      raffleDrawing = null;

      raffleWinner = { player: winner, prize: prize };
      state.raffleHistory.unshift({
        time: Date.now(),
        name: winner.name,
        level: winner.level,
        prize: prize
      });
      if (state.raffleHistory.length > 20) state.raffleHistory.length = 20;
      save();
      render();
    }, RAFFLE_SUSPENSE_MS);
  }

  // Clear the current winner highlight and the recent-draws log. Also cancels
  // an in-progress draw. Leaves the prize list intact (that's inventory).
  function clearRaffle() {
    if (raffleTimers.cycle) { clearInterval(raffleTimers.cycle); raffleTimers.cycle = null; }
    if (raffleTimers.reveal) { clearTimeout(raffleTimers.reveal); raffleTimers.reveal = null; }
    raffleDrawing = null;
    raffleWinner = null;
    state.raffleHistory = [];
    save();
    render();
  }

  // ---- Prizes ---------------------------------------------------------
  function addPrize(label) {
    var trimmed = (label || '').trim();
    if (!trimmed) return;
    state.prizes.push({ id: newId(), label: trimmed });
    save();
    render();
  }

  function removePrize(id) {
    state.prizes = state.prizes.filter(function (p) { return p.id !== id; });
    save();
    render();
  }

  // Move a player from the challenge queue back to the main waiting queue.
  function moveToQueue(id) {
    var idx = -1;
    for (var i = 0; i < state.challengeQueue.length; i++) {
      if (state.challengeQueue[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;
    var player = state.challengeQueue.splice(idx, 1)[0];
    enqueue(player);
    save();
    render();
  }

  // Find a player anywhere (queue or courts) by id.
  function findPlayer(id) {
    var p = state.queue.filter(function (x) { return x.id === id; })[0];
    if (p) return p;
    p = state.challengeQueue.filter(function (x) { return x.id === id; })[0];
    if (p) return p;
    for (var i = 0; i < state.courts.length; i++) {
      var m = state.courts[i].players.filter(function (x) { return x.id === id; })[0];
      if (m) return m;
    }
    return null;
  }

  function clearPartner(player) {
    if (!player || player.partnerId == null) return;
    var other = findPlayer(player.partnerId);
    if (other) other.partnerId = null;
    player.partnerId = null;
  }

  // Toggle partner pairing driven by the 🤝 button.
  //  - If nothing pending: if this player is already paired, unpair them;
  //    otherwise arm them as the pending partner.
  //  - If someone is pending: link the two (or cancel if it's the same one).
  function togglePartner(id) {
    // Partnering only makes sense in doubles.
    if (state.singles) {
      window.alert('Partners apply to doubles. Switch off Singles to pair players.');
      return;
    }
    var player = findPlayer(id);
    if (!player) return;

    if (pendingPartnerId == null) {
      if (player.partnerId != null) {
        clearPartner(player); // clicking a paired player unpairs them
      } else {
        pendingPartnerId = id; // arm for pairing
      }
      save();
      render();
      return;
    }

    if (pendingPartnerId === id) {
      pendingPartnerId = null; // clicked the same player again: cancel
      render();
      return;
    }

    var first = findPlayer(pendingPartnerId);
    pendingPartnerId = null;
    if (!first) {
      render();
      return;
    }
    // Replace any existing pairings on either side, then link mutually.
    clearPartner(first);
    clearPartner(player);
    first.partnerId = player.id;
    player.partnerId = first.id;
    save();
    render();
  }

  // Remove a player from wherever they are (queue or a court), breaking any
  // partnership and pending-pair state. Returns the removed player object.
  function pullPlayer(id) {
    var player = findPlayer(id);
    if (!player) return null;
    clearPartner(player);
    if (pendingPartnerId === id) pendingPartnerId = null;

    state.queue = state.queue.filter(function (p) { return p.id !== id; });
    state.challengeQueue = state.challengeQueue.filter(function (p) { return p.id !== id; });
    state.courts.forEach(function (c) {
      var had = c.players.some(function (p) { return p.id === id; });
      if (had) {
        // Pulling a current holder off an active challenge game ends the streak.
        if (playsAsChallenge(c) && state.challengeStreak.ids.indexOf(id) !== -1) {
          resetChallengeStreak();
        }
        c.players = c.players.filter(function (p) { return p.id !== id; });
        if (!c.players.length) {
          c.startedAt = null;
          c.score = { a: 0, b: 0 };
        }
      }
    });
    return player;
  }

  // Check a player out: record their departure time and move them to the
  // checked-out list. Their stats are preserved.
  function checkOut(id) {
    var player = pullPlayer(id);
    if (!player) return;
    player.timeOut = Date.now();
    state.checkedOut.unshift(player);
    save();
    render();
  }

  // Check a player back in: create a fresh queue entry with a new arrival
  // time, keeping their win/loss/games record. Clears their old departure.
  function checkIn(id) {
    var idx = -1;
    for (var i = 0; i < state.checkedOut.length; i++) {
      if (state.checkedOut[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;
    var player = state.checkedOut.splice(idx, 1)[0];
    player.timeIn = Date.now();
    player.timeOut = null;
    player.partnerId = null;
    enqueue(player);
    save();
    render();
  }

  // Permanently drop a checked-out player from the record.
  function removeCheckedOut(id) {
    state.checkedOut = state.checkedOut.filter(function (p) { return p.id !== id; });
    save();
    render();
  }

  function removeFromQueue(id) {
    // Removing a player also breaks any partnership they were in.
    var leaving = findPlayer(id);
    if (leaving) clearPartner(leaving);
    if (pendingPartnerId === id) pendingPartnerId = null;
    state.queue = state.queue.filter(function (p) {
      return p.id !== id;
    });
    save();
    render();
  }

  function addCourt() {
    state.courts.push({ id: newId(), players: [], startedAt: null, score: { a: 0, b: 0 }, challengeGame: false });
    save();
    render();
  }

  // Adjust a court's score. side is 'a'/'b', delta is +1/-1 (min 0).
  function adjustScore(courtId, side, delta) {
    var court = getCourt(courtId);
    if (!court || !court.players.length) return;
    ensureScore(court);
    court.score[side] = Math.max(0, (court.score[side] || 0) + delta);
    save();
    render();
  }

  function removeCourt() {
    // Remove the last court. If it has players, send them back to the queue
    // this court draws from.
    if (!state.courts.length) return;
    var court = state.courts[state.courts.length - 1];
    var wasChallenge = playsAsChallenge(court);
    if (court.players.length) {
      var ok = window.confirm(
        'That court has players on it. Remove it and send them back to the queue?'
      );
      if (!ok) return;
      court.players.forEach(function (p) {
        if (wasChallenge) enqueueChallenge(p);
        else enqueue(p);
      });
    }
    if (wasChallenge) resetChallengeStreak();
    state.courts.pop();
    save();
    render();
  }

  // Fill a specific open court with the next players from the queue.
  function assignCourt(courtId) {
    var court = state.courts.filter(function (c) {
      return c.id === courtId;
    })[0];
    if (!court || court.players.length) return;

    var need = playersPerCourt();
    // Challenge court prefers challengers but falls back to the main queue
    // when the challenge queue can't fill the court.
    var src = fillSourceFor(court, need);
    var source = src.list;
    if (source.length < need) return; // not enough players

    var picked = pickPlayers(need, source);
    if (!picked || picked.length < need) return; // couldn't fill cleanly

    // Remove the picked players from whichever queue they came from.
    var pickedIds = {};
    picked.forEach(function (p) {
      pickedIds[p.id] = true;
    });
    var remaining = source.filter(function (p) {
      return !pickedIds[p.id];
    });
    setSourceList(src.kind, remaining);

    // Arrange so partners share a side (doubles). No-op in singles.
    picked = arrangeSides(picked, need);

    picked.forEach(function (p) {
      ensureRecord(p).games += 1;
    });
    court.players = picked;
    court.startedAt = Date.now();
    court.score = { a: 0, b: 0 };
    // This game runs under challenge rules only if it was drawn from the
    // challenge queue. A main-queue fallback fill is a normal game.
    court.challengeGame = isChallengeCourt(court) && src.kind === 'challenge';
    save();
    render();
  }

  // Build the ordered list of candidates from a source queue (balanced or
  // plain order). Defaults to the main waiting queue.
  function orderedCandidates(source) {
    var pool = source || state.queue;
    if (state.balance) {
      return pool
        .map(function (p, i) {
          return { p: p, i: i };
        })
        .sort(function (x, y) {
          var gx = x.p.games || 0;
          var gy = y.p.games || 0;
          if (gx !== gy) return gx - gy;
          return x.i - y.i;
        })
        .map(function (o) {
          return o.p;
        });
    }
    return pool.slice();
  }

  // Choose `need` players from the queue, keeping partner pairs together:
  // when a candidate is taken, their partner (if also waiting) is taken too,
  // as long as there's room. If pulling a pair would overflow the last slot,
  // that pair is skipped so we don't split them.
  function pickPlayers(need, source) {
    var order = orderedCandidates(source);
    var inQueue = {};
    order.forEach(function (p) { inQueue[p.id] = true; });

    var chosen = [];
    var taken = {};

    for (var i = 0; i < order.length && chosen.length < need; i++) {
      var p = order[i];
      if (taken[p.id]) continue;

      var partner =
        p.partnerId != null && inQueue[p.partnerId] && !taken[p.partnerId]
          ? findPlayer(p.partnerId)
          : null;

      if (partner) {
        // Only take the pair if both fit; otherwise skip to keep them together.
        if (chosen.length + 2 <= need) {
          chosen.push(p, partner);
          taken[p.id] = true;
          taken[partner.id] = true;
        }
        // else: leave this pair for a later (full) court.
      } else {
        chosen.push(p);
        taken[p.id] = true;
      }
    }

    // If partner-keeping left us short (e.g. only a pair remained for a
    // single open slot), fall back to filling remaining slots in order.
    if (chosen.length < need) {
      for (var j = 0; j < order.length && chosen.length < need; j++) {
        if (!taken[order[j].id]) {
          chosen.push(order[j]);
          taken[order[j].id] = true;
        }
      }
    }
    return chosen.slice(0, need);
  }

  // Reorder picked players so partnered pairs share a side. For doubles the
  // sides are slots [0,1] (A) and [2,3] (B). Singles: unchanged.
  var LEVEL_WEIGHT = { novice: 1, intermediate: 2, advanced: 3 };
  function skillOf(p) {
    return LEVEL_WEIGHT[p.level] || 2;
  }
  function sideSkill(list) {
    return list.reduce(function (s, p) { return s + skillOf(p); }, 0);
  }

  function arrangeSides(players, need) {
    if (need !== 4) return players;

    // Group into fixed partner pairs and free singles.
    var used = {};
    var pairs = [];
    var singlesList = [];
    players.forEach(function (p) {
      if (used[p.id]) return;
      var partnerHere =
        p.partnerId != null &&
        players.filter(function (x) { return x.id === p.partnerId; })[0];
      if (partnerHere) {
        pairs.push([p, partnerHere]);
        used[p.id] = true;
        used[partnerHere.id] = true;
      } else {
        singlesList.push(p);
        used[p.id] = true;
      }
    });

    var sideA, sideB;

    if (pairs.length >= 2) {
      // Two fixed pairs: one per side (no other option).
      sideA = pairs[0].slice();
      sideB = pairs[1].slice();
    } else if (pairs.length === 1) {
      // Pair fills one side; the two singles form the other. No choice.
      sideA = pairs[0].slice();
      sideB = singlesList.slice(0, 2);
    } else {
      // Four singles. If skill-balancing is on, pick the 2-2 split whose
      // side totals are closest; otherwise keep incoming order.
      if (state.skillBalance) {
        var p0 = singlesList[0], p1 = singlesList[1], p2 = singlesList[2], p3 = singlesList[3];
        // Three distinct ways to split 4 into two pairs.
        var splits = [
          [[p0, p1], [p2, p3]],
          [[p0, p2], [p1, p3]],
          [[p0, p3], [p1, p2]]
        ];
        var best = splits[0];
        var bestDiff = Infinity;
        splits.forEach(function (sp) {
          var diff = Math.abs(sideSkill(sp[0]) - sideSkill(sp[1]));
          if (diff < bestDiff) { bestDiff = diff; best = sp; }
        });
        sideA = best[0];
        sideB = best[1];
      } else {
        sideA = singlesList.slice(0, 2);
        sideB = singlesList.slice(2, 4);
      }
    }

    return sideA.concat(sideB);
  }

  function getCourt(courtId) {
    return state.courts.filter(function (c) {
      return c.id === courtId;
    })[0];
  }

  // Show the inline swap picker for a specific on-court player.
  function openSwap(courtId, playerId) {
    var court = getCourt(courtId);
    var pool = court && playsAsChallenge(court) ? state.challengeQueue : state.queue;
    if (!pool.length) {
      window.alert('No one is waiting in the queue to swap in.');
      return;
    }
    swappingSlot = { courtId: courtId, playerId: playerId };
    render();
  }

  function cancelSwap() {
    swappingSlot = null;
    render();
  }

  // Swap a specific on-court player for a chosen waiting player. The outgoing
  // player returns to the queue; the incoming player takes the same slot/side.
  // Timer and score are preserved. Counts a game for the incoming player.
  function swapPlayerWith(courtId, playerId, incomingId) {
    var court = getCourt(courtId);
    if (!court) { swappingSlot = null; render(); return; }
    var slot = -1;
    for (var i = 0; i < court.players.length; i++) {
      if (court.players[i].id === playerId) { slot = i; break; }
    }
    // Swap in from the line this court draws from (active-challenge aware).
    var toChallenge = playsAsChallenge(court);
    var pool = toChallenge ? state.challengeQueue : state.queue;
    var incoming = pool.filter(function (p) { return p.id === incomingId; })[0];
    if (slot === -1 || !incoming) { swappingSlot = null; render(); return; }

    // Manual placement on a specific side: break partnerships to avoid
    // splitting a pair across sides.
    clearPartner(incoming);
    if (toChallenge) {
      state.challengeQueue = state.challengeQueue.filter(function (p) { return p.id !== incoming.id; });
    } else {
      state.queue = state.queue.filter(function (p) { return p.id !== incoming.id; });
    }

    var outgoing = court.players[slot];
    clearPartner(outgoing);
    // Swapping out a current holder breaks the challenge-court streak.
    if (toChallenge && state.challengeStreak.ids.indexOf(outgoing.id) !== -1) {
      resetChallengeStreak();
    }
    court.players[slot] = incoming;
    ensureRecord(incoming).games += 1;
    if (toChallenge) enqueueChallenge(outgoing);
    else enqueue(outgoing);

    swappingSlot = null;
    save();
    render();
  }

  // Open/close the inline lineup editor for a court.
  function startEdit(courtId) {
    editingCourtId = courtId;
    render();
  }
  function cancelEdit() {
    editingCourtId = null;
    render();
  }

  // Save a manually chosen lineup for a court. `slotIds` is an array of
  // player ids (or '' for empty slots), one per court slot. Players moving
  // onto the court are pulled from wherever they are; players removed go
  // back to the queue. Games are counted only when the court becomes full.
  function saveLineup(courtId, slotIds) {
    var court = getCourt(courtId);
    if (!court) return;

    // Resolve chosen player ids (ignore empties and duplicates).
    var chosenIds = [];
    var seen = {};
    slotIds.forEach(function (idStr) {
      if (!idStr) return;
      var id = Number(idStr);
      if (seen[id]) return; // guard against picking the same player twice
      seen[id] = true;
      chosenIds.push(id);
    });

    // Build a lookup of every player currently anywhere (both queues +
    // all courts).
    var everywhere = {};
    state.queue.forEach(function (p) {
      everywhere[p.id] = p;
    });
    state.challengeQueue.forEach(function (p) {
      everywhere[p.id] = p;
    });
    state.courts.forEach(function (c) {
      c.players.forEach(function (p) {
        everywhere[p.id] = p;
      });
    });

    var wasFull = court.players.length > 0 &&
      court.players.length === playersPerCourt();

    // Players leaving this court (were here, not chosen) go back to queue.
    var chosenSet = {};
    chosenIds.forEach(function (id) { chosenSet[id] = true; });
    var leaving = court.players.filter(function (p) {
      return !chosenSet[p.id];
    });

    // New lineup, in slot order.
    var newPlayers = chosenIds.map(function (id) {
      return everywhere[id];
    }).filter(Boolean);

    // Remove chosen players from BOTH queues and from any OTHER court.
    state.queue = state.queue.filter(function (p) {
      return !chosenSet[p.id];
    });
    state.challengeQueue = state.challengeQueue.filter(function (p) {
      return !chosenSet[p.id];
    });
    state.courts.forEach(function (c) {
      if (c.id === courtId) return;
      c.players = c.players.filter(function (p) {
        return !chosenSet[p.id];
      });
      if (!c.players.length) c.startedAt = null;
    });

    // Send leaving players back to the line this court draws from. Use the
    // challenge queue only while the court is actively a challenge game.
    var toChallenge = playsAsChallenge(court);
    leaving.forEach(function (p) {
      if (toChallenge) enqueueChallenge(p);
      else enqueue(p);
    });

    // A manual lineup change on the challenge court only breaks the streak
    // if a current holder is removed. Merely adding challengers to fill an
    // empty side (defenders waiting for opponents) keeps the streak alive.
    if (toChallenge && state.challengeStreak.ids.length) {
      var holderRemoved = state.challengeStreak.ids.some(function (id) {
        return !chosenSet[id];
      });
      if (holderRemoved) resetChallengeStreak();
    }

    court.players = newPlayers;

    // Record whether Court 1's resulting game runs under challenge rules.
    // `toChallenge` was captured before the lineup changed and reflects the
    // court's mode at edit time (defending holders, or challengers waiting).
    if (isChallengeCourt(court)) {
      court.challengeGame = toChallenge;
    }

    var nowFull = newPlayers.length === playersPerCourt();
    if (nowFull && !wasFull) {
      // Court just became a full game: start timer, reset score, count games.
      court.startedAt = Date.now();
      court.score = { a: 0, b: 0 };
      newPlayers.forEach(function (p) {
        ensureRecord(p).games += 1;
      });
    } else if (!newPlayers.length) {
      court.startedAt = null;
      court.score = { a: 0, b: 0 };
    } else if (!nowFull) {
      // Partial court, not a live game yet.
      court.startedAt = null;
    }

    editingCourtId = null;
    save();
    render();
  }

  // Split a court's players into two sides. In doubles the first half is
  // side A and the second half side B; in singles it's one player each.
  function courtSides(court) {
    var half = court.players.length / 2;
    return {
      a: court.players.slice(0, half),
      b: court.players.slice(half)
    };
  }

  // Finish a game. `winner` may be 'a' or 'b' (explicit), or omitted to
  // decide from the court score. Records W/L, logs the result with the
  // score, then rotates players back to the queue and clears the court.
  function finishCourt(courtId, winner) {
    var court = state.courts.filter(function (c) {
      return c.id === courtId;
    })[0];
    if (!court || !court.players.length) return;

    ensureScore(court);
    var score = court.score;

    // If no explicit winner, use the score. Refuse to guess on a tie.
    if (winner !== 'a' && winner !== 'b') {
      if (score.a === score.b) {
        window.alert(
          "It's a tie (" + score.a + '-' + score.b + '). Adjust the score, ' +
          'or use the A/B win buttons to pick a winner.'
        );
        return;
      }
      winner = score.a > score.b ? 'a' : 'b';
    }

    var sides = courtSides(court);
    var winners = winner === 'b' ? sides.b : sides.a;
    var losers = winner === 'b' ? sides.a : sides.b;
    // Score from the winner's / loser's perspective for the log.
    var winScore = winner === 'b' ? score.b : score.a;
    var loseScore = winner === 'b' ? score.a : score.b;

    winners.forEach(function (p) {
      ensureRecord(p).wins += 1;
    });
    losers.forEach(function (p) {
      ensureRecord(p).losses += 1;
    });

    state.history.unshift({
      time: Date.now(),
      winners: winners.map(function (p) { return p.name; }),
      losers: losers.map(function (p) { return p.name; }),
      winScore: winScore,
      loseScore: loseScore
    });
    if (state.history.length > 50) state.history.length = 50;

    // Only run king-of-the-court rules if THIS game was a challenge game
    // (lineup drawn from the challenge queue). A main-queue fallback game on
    // Court 1 finishes like any normal court.
    if (isChallengeCourt(court) && court.challengeGame === true) {
      finishChallengeCourt(court, winners, losers);
      return;
    }

    // Standard court (or challenge court running a main-queue fallback game):
    // rotate ALL finishing players back to the main waiting queue, then
    // shuffle so the order is randomized regardless of result.
    winners.concat(losers).forEach(function (p) {
      enqueue(p);
    });
    state.queue = shuffle(state.queue);

    court.players = [];
    court.startedAt = null;
    court.score = { a: 0, b: 0 };

    // Auto-start the next group on this court if enabled and enough players
    // are waiting. assignCourt handles selection (partner/balance aware),
    // persistence, and re-render.
    if (state.autoStart && state.queue.length >= playersPerCourt()) {
      assignCourt(court.id);
      return;
    }

    save();
    render();
  }

  // Resolve the challenge court after a game: king-of-the-court rules.
  // The WINNERS stay on (fixed), the LOSERS go back to the challenge queue,
  // and the next challengers fill the now-empty side. Tracks the holders'
  // consecutive-win streak and logs a report every 3 wins in a row.
  function finishChallengeCourt(court, winners, losers) {
    var perSide = playersPerCourt() / 2;

    // Update the holders' win streak. If the same team is still winning,
    // extend it; otherwise a new team has taken the throne, so start at 1.
    var key = teamKey(winners);
    var prevKey = state.challengeStreak.ids.join('-');
    if (key === prevKey && state.challengeStreak.count > 0) {
      state.challengeStreak.count += 1;
    } else {
      state.challengeStreak = { ids: [], names: [], count: 1 };
      state.challengeStreak.ids = winners
        .map(function (p) { return p.id; })
        .sort(function (a, b) { return a - b; });
    }
    state.challengeStreak.names = winners.map(function (p) { return p.name; });

    // Milestone: 3 consecutive wins by the current holders. Report it AND
    // retire the champions — they are removed from the challenge rotation and
    // sent to the MAIN waiting queue, so they will NOT rejoin the challenge
    // court unless an operator adds them back to the challenge queue (⚔).
    var retireChampions =
      state.challengeStreak.count > 0 && state.challengeStreak.count % 3 === 0;

    if (retireChampions) {
      var report = {
        time: Date.now(),
        names: winners.map(function (p) { return p.name; }),
        count: state.challengeStreak.count
      };
      state.challengeReports.unshift(report);
      if (state.challengeReports.length > 50) state.challengeReports.length = 50;
      challengeFlash = { names: report.names, count: report.count };
    }

    // Losers always leave the throne and rejoin the back of the challenge queue.
    losers.forEach(function (p) {
      enqueueChallenge(p);
    });

    if (retireChampions) {
      // Champions step down and are REMOVED from all rotation: they do not
      // rejoin the challenge queue OR the main queue. They are set aside in
      // the checked-out list (stats preserved) until an operator adds them
      // back via "Check in". Break any pairing first.
      winners.forEach(function (p) {
        clearPartner(p);
        p.timeOut = Date.now();
        state.checkedOut.unshift(p);
      });
      resetChallengeStreak();
      state.challengeQueue = shuffle(state.challengeQueue);

      // Start a fresh full challenge game. Prefer challengers; if the
      // challenge queue is empty, fall back to the main waiting queue.
      court.players = [];
      court.startedAt = null;
      court.score = { a: 0, b: 0 };
      var full = playersPerCourt();
      if (state.challengeQueue.length >= full || state.queue.length >= full) {
        assignCourt(court.id); // fallback-aware; handles persistence + render
        return;
      }
      save();
      render();
      return;
    }

    // Not a milestone: normal king-of-the-court. Winners stay, losers out,
    // pull the next opponents to fill the vacated side. Prefer challengers;
    // if the challenge queue can't supply a full side, fall back to the
    // main waiting queue.
    state.challengeQueue = shuffle(state.challengeQueue);

    var incoming = [];
    var fillKind = state.challengeQueue.length >= perSide
      ? 'challenge'
      : (state.queue.length >= perSide ? 'main' : null);

    if (fillKind) {
      var fillList = fillKind === 'challenge' ? state.challengeQueue : state.queue;
      incoming = pickPlayers(perSide, fillList);
      var takenIds = {};
      incoming.forEach(function (p) { takenIds[p.id] = true; });
      setSourceList(fillKind, fillList.filter(function (p) {
        return !takenIds[p.id];
      }));
      incoming.forEach(function (p) {
        ensureRecord(p).games += 1;
      });
    }

    if (incoming.length === perSide) {
      // Winners stay on side A; opponents form side B. Fresh timer/score.
      court.players = winners.concat(incoming);
      court.startedAt = Date.now();
      court.score = { a: 0, b: 0 };
      // Keep running challenge rules only if the new opponents are actual
      // challengers. If we filled from the main queue, the next game is a
      // normal game (challenge court effectively disabled until challengers
      // return).
      court.challengeGame = fillKind === 'challenge';
    } else {
      // Nobody waiting in either line: keep the winners on, leave side B
      // empty (court shows as "Filling" / defending, waiting for opponents).
      court.players = winners.slice();
      court.startedAt = null;
      court.score = { a: 0, b: 0 };
      court.challengeGame = true; // still defending as the reigning champions
    }

    save();
    render();
  }

  function resetAll() {
    var ok = window.confirm('Clear all players, courts, and the queue?');
    if (!ok) return;
    state = {
      queue: [], challengeQueue: [], courts: [], history: [], checkedOut: [],
      challengeStreak: { ids: [], names: [], count: 0 }, challengeReports: [],
      raffleHistory: [], prizes: state.prizes || [],
      singles: state.singles, balance: state.balance,
      autoStart: state.autoStart, skillBalance: state.skillBalance, nextId: 1
    };
    save();
    render();
  }

  function setSingles(on) {
    // Only allow switching mode when no court is mid-game, to avoid
    // half-filled courts under the new size.
    var midGame = state.courts.some(function (c) {
      return c.players.length > 0;
    });
    if (midGame) {
      window.alert(
        'Finish the games in progress before switching between singles and doubles.'
      );
      el.singlesToggle.checked = state.singles;
      return;
    }
    state.singles = on;
    save();
    render();
  }

  // ---- Rendering ------------------------------------------------------
  function formatElapsed(startedAt) {
    if (!startedAt) return '';
    var secs = Math.floor((Date.now() - startedAt) / 1000);
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
  }

  function clockTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Human duration between two timestamps, e.g. "1h 15m" or "22m".
  function durationText(from, to) {
    var mins = Math.max(0, Math.round((to - from) / 60000));
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function recordText(p) {
    return (p.wins || 0) + '-' + (p.losses || 0);
  }

  function recordBadge(p) {
    return '<span class="record" title="Wins-Losses">' + recordText(p) + '</span>';
  }

  var LEVEL_INFO = {
    novice: { abbr: 'NOV', label: 'Novice' },
    intermediate: { abbr: 'INT', label: 'Intermediate' },
    advanced: { abbr: 'ADV', label: 'Advanced' }
  };

  function levelBadge(p) {
    var lvl = LEVEL_INFO[p.level] ? p.level : 'intermediate';
    var info = LEVEL_INFO[lvl];
    return '<span class="level-badge level-' + lvl + '" title="' + info.label +
      '">' + info.abbr + '</span>';
  }

  // Which player ids would be picked next for an open court, honoring the
  // current balance setting. Used to tag "up next" in the queue.
  function nextUpIds(need, source) {
    var pool = source || state.queue;
    if (pool.length < need) return {};
    var chosen = pickPlayers(need, pool); // same logic assignCourt uses (partner-aware)
    var ids = {};
    chosen.forEach(function (p) {
      ids[p.id] = true;
    });
    return ids;
  }

  function renderQueue() {
    var need = playersPerCourt();
    el.queueCount.textContent = state.queue.length;

    if (!state.queue.length) {
      el.queueList.innerHTML = '';
      el.queueEmpty.hidden = false;
      return;
    }
    el.queueEmpty.hidden = true;

    // The main queue feeds a next group when any non-challenge court is open,
    // OR when the challenge court is open but the challenge queue is empty
    // (Court 1 falls back to the main queue in that case).
    var challengeFallsBackToMain =
      challengeCourtOpen() && state.challengeQueue.length < need;
    var upIds = (anyOpenMainCourt() || challengeFallsBackToMain)
      ? nextUpIds(need)
      : {};

    var html = '';
    state.queue.forEach(function (p, i) {
      var upNext = !!upIds[p.id];
      var since = typeof p.waitingSince === 'number' ? p.waitingSince : Date.now();

      var partner = p.partnerId != null ? findPlayer(p.partnerId) : null;
      var partnerTag = partner
        ? '<span class="partner-tag" title="Partner">🤝 ' + esc(partner.name) + '</span>'
        : '';
      var pairArmed = pendingPartnerId === p.id;
      var pairBtnClass = 'icon-btn partner-btn' +
        (partner ? ' paired' : '') + (pairArmed ? ' armed' : '');
      var pairTitle = state.singles
        ? 'Partners apply to doubles'
        : partner ? 'Unpair' : pairArmed ? 'Click another player to pair (or click again to cancel)' : 'Pair with another player';

      html +=
        '<li class="queue-item' + (pairArmed ? ' pairing' : '') + '">' +
        '<span class="queue-pos">' + (i + 1) + '</span>' +
        levelBadge(p) +
        '<span class="queue-name">' + esc(p.name) + partnerTag + '</span>' +
        '<span class="wait-badge" data-waiting="' + since + '" title="Time waiting">' +
        '⏱ ' + formatElapsed(since) + '</span>' +
        '<span class="games-badge" title="Games played">' +
        (p.games || 0) + 'G</span>' +
        recordBadge(p) +
        (upNext ? '<span class="up-next">up next</span>' : '') +
        '<span class="in-time" title="Checked in">in ' + clockTime(p.timeIn) + '</span>' +
        '<button class="' + pairBtnClass + '" data-partner="' + p.id + '" title="' +
        pairTitle + '">🤝</button>' +
        '<button class="icon-btn to-challenge-btn" data-to-challenge="' + p.id +
        '" title="Move to challenge court queue">⚔</button>' +
        '<button class="icon-btn checkout-btn" data-checkout="' + p.id + '" title="Check out">⏻</button>' +
        '<button class="icon-btn" data-remove="' + p.id + '" title="Remove">✕</button>' +
        '</li>';
    });
    el.queueList.innerHTML = html;
  }

  // Render the separate challenge-court waiting line. Mirrors the main queue
  // item layout (level, name, partner tag, wait/games/record badges) but with
  // a ← button to send a player back to the main queue instead of the ⚔.
  function renderChallengeQueue() {
    el.challengeCount.textContent = state.challengeQueue.length;

    if (!state.challengeQueue.length) {
      el.challengeList.innerHTML = '';
      el.challengeEmpty.hidden = false;
      return;
    }
    el.challengeEmpty.hidden = true;

    var need = playersPerCourt();
    var upIds = challengeCourtOpen()
      ? nextUpIds(need, state.challengeQueue)
      : {};

    var html = '';
    state.challengeQueue.forEach(function (p, i) {
      var upNext = !!upIds[p.id];
      var since = typeof p.waitingSince === 'number' ? p.waitingSince : Date.now();

      var partner = p.partnerId != null ? findPlayer(p.partnerId) : null;
      var partnerTag = partner
        ? '<span class="partner-tag" title="Partner">🤝 ' + esc(partner.name) + '</span>'
        : '';
      var pairArmed = pendingPartnerId === p.id;
      var pairBtnClass = 'icon-btn partner-btn' +
        (partner ? ' paired' : '') + (pairArmed ? ' armed' : '');
      var pairTitle = state.singles
        ? 'Partners apply to doubles'
        : partner ? 'Unpair' : pairArmed ? 'Click another player to pair (or click again to cancel)' : 'Pair with another player';

      html +=
        '<li class="queue-item challenge-item' + (pairArmed ? ' pairing' : '') + '">' +
        '<span class="queue-pos">' + (i + 1) + '</span>' +
        levelBadge(p) +
        '<span class="queue-name">' + esc(p.name) + partnerTag + '</span>' +
        '<span class="wait-badge" data-waiting="' + since + '" title="Time waiting">' +
        '⏱ ' + formatElapsed(since) + '</span>' +
        '<span class="games-badge" title="Games played">' +
        (p.games || 0) + 'G</span>' +
        recordBadge(p) +
        (upNext ? '<span class="up-next">up next</span>' : '') +
        '<span class="in-time" title="Checked in">in ' + clockTime(p.timeIn) + '</span>' +
        '<button class="' + pairBtnClass + '" data-partner="' + p.id + '" title="' +
        pairTitle + '">🤝</button>' +
        '<button class="icon-btn to-queue-btn" data-to-queue="' + p.id +
        '" title="Move back to main queue">↩</button>' +
        '<button class="icon-btn checkout-btn" data-co-challenge="' + p.id + '" title="Check out">⏻</button>' +
        '<button class="icon-btn" data-remove-challenge="' + p.id + '" title="Remove">✕</button>' +
        '</li>';
    });
    el.challengeList.innerHTML = html;
  }

  // Raffle: eligible-count badge, draw button state, latest winner, and a
  // short log of recent draws.
  function renderRaffle() {
    var pool = rafflePool();
    el.rafflePool.textContent = pool.length;
    // While a draw is animating, lock the Draw button and label it.
    el.raffleDrawBtn.disabled = pool.length === 0 || !!raffleDrawing;
    el.raffleDrawBtn.textContent = raffleDrawing ? '🎲 Drawing…' : '🎲 Draw winner';
    el.raffleClearBtn.disabled =
      !raffleDrawing && !raffleWinner && state.raffleHistory.length === 0;

    if (raffleDrawing) {
      // Suspense: flash a rolling name until the reveal fires.
      el.raffleWinner.hidden = false;
      el.raffleWinner.className = 'raffle-winner drawing';
      el.raffleWinner.innerHTML =
        '<span class="raffle-trophy">🎲</span>' +
        '<span class="raffle-winner-name rolling">' + esc(raffleDrawing.name) + '</span>' +
        '<span class="raffle-winner-tag">drawing…</span>';
    } else if (raffleWinner && raffleWinner.player) {
      // Latest winner highlight (transient), including the prize they won.
      var w = raffleWinner.player;
      var prizeHtml = raffleWinner.prize
        ? '<span class="raffle-prize">🎁 ' + esc(raffleWinner.prize) + '</span>'
        : '<span class="raffle-prize none">no prize set</span>';
      el.raffleWinner.hidden = false;
      el.raffleWinner.className = 'raffle-winner';
      el.raffleWinner.innerHTML =
        '<span class="raffle-trophy">🏆</span>' +
        levelBadge(w) +
        '<span class="raffle-winner-name">' + esc(w.name) + '</span>' +
        '<span class="raffle-winner-tag">winner</span>' +
        prizeHtml;
    } else {
      el.raffleWinner.hidden = true;
      el.raffleWinner.className = 'raffle-winner';
      el.raffleWinner.innerHTML = '';
    }

    // Empty hint only when nobody is eligible and there's no history.
    el.raffleEmpty.hidden = pool.length > 0 || state.raffleHistory.length > 0;

    renderPrizes();

    // Recent draws log (with prize, if any).
    var html = '';
    state.raffleHistory.forEach(function (r) {
      var t = new Date(r.time).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      });
      var prizeTxt = r.prize
        ? '<span class="raffle-h-prize">🎁 ' + esc(r.prize) + '</span>'
        : '';
      html +=
        '<li class="raffle-history-item">' +
        '<span class="history-time">' + t + '</span>' +
        '<span class="raffle-h-name">🎲 ' + esc(r.name) + '</span>' +
        prizeTxt +
        '</li>';
    });
    el.raffleHistory.innerHTML = html;
  }

  // Render the editable prize list.
  function renderPrizes() {
    el.prizeCount.textContent = state.prizes.length;
    if (!state.prizes.length) {
      el.prizeList.innerHTML = '';
      el.prizeEmpty.hidden = false;
      return;
    }
    el.prizeEmpty.hidden = true;

    var html = '';
    state.prizes.forEach(function (p) {
      html +=
        '<li class="prize-item">' +
        '<span class="prize-gift">🎁</span>' +
        '<span class="prize-label">' + esc(p.label) + '</span>' +
        '<button class="icon-btn" data-remove-prize="' + p.id + '" title="Remove prize">✕</button>' +
        '</li>';
    });
    el.prizeList.innerHTML = html;
  }

  function renderCourts() {
    el.courtCount.textContent = state.courts.length;
    var need = playersPerCourt();

    if (!state.courts.length) {
      el.courtsGrid.innerHTML =
        '<div class="empty-hint">No courts yet. Add one with “+ Court”.</div>';
      return;
    }

    var html = '';
    state.courts.forEach(function (c, idx) {
      var count = c.players.length;
      var isFull = count === need && count > 0; // full, live game
      var isPartial = count > 0 && count < need; // hand-picked, not started
      var editing = editingCourtId === c.id;
      var chPos = isChallengeCourt(c); // positional: Court 1
      var chChallenge = playsAsChallenge(c); // actively running challenge rules
      html += '<div class="court ' + (isFull ? 'full' : '') +
        (chChallenge ? ' challenge-court' : '') +
        (editing ? ' editing' : '') + '">';
      html +=
        '<div class="court-title">Court ' + (idx + 1) +
        (chChallenge
          ? ' <span class="challenge-court-tag">⚔ Challenge</span>'
          : (chPos ? ' <span class="challenge-court-tag off">⚔ idle</span>' : '')) +
        '<span class="court-status">' +
        (editing ? 'Editing' : isFull ? 'In play' : isPartial ? 'Filling' : 'Open') +
        '</span></div>';

      if (editing) {
        html += renderCourtEditor(c, need);
        html += '</div>';
        return;
      }

      html += '<div class="court-players">';
      if (isFull) {
        var sides = courtSides(c);
        var sideLabel = state.singles ? '' : ' side';
        ['a', 'b'].forEach(function (key) {
          html += '<div class="court-side" data-side="' + key + '">';
          html += '<div class="side-tag">' +
            (key === 'a' ? 'A' : 'B') + sideLabel + '</div>';
          sides[key].forEach(function (p) {
            var mark = p.partnerId != null ? '<span class="partner-dot" title="Partnered">🤝</span> ' : '';
            var isSwapping = swappingSlot &&
              swappingSlot.courtId === c.id && swappingSlot.playerId === p.id;

            if (isSwapping) {
              // Inline picker: choose who from the court's line swaps in.
              var swapPool = chChallenge ? state.challengeQueue : state.queue;
              var opts = '<option value="">— choose player —</option>';
              swapPool.forEach(function (w) {
                opts += '<option value="' + w.id + '">' + esc(w.name) +
                  ' (' + (w.games || 0) + 'G)</option>';
              });
              html +=
                '<div class="court-player swapping">' +
                '<span class="cp-name">' + mark + esc(p.name) + '</span>' +
                '<span class="swap-picker">' +
                '<select class="swap-select" data-swap-court="' + c.id +
                '" data-swap-player="' + p.id + '">' + opts + '</select>' +
                '<button class="icon-btn" data-cancel-swap="1" title="Cancel">✕</button>' +
                '</span>' +
                '</div>';
            } else {
              var canSwap = (chChallenge ? state.challengeQueue.length : state.queue.length) > 0;
              var swapBtn =
                '<button class="icon-btn swap-btn" data-open-swap-court="' + c.id +
                '" data-open-swap-player="' + p.id + '"' +
                (canSwap ? '' : ' disabled') +
                ' title="' + (canSwap ? 'Switch this player' : 'No one waiting to swap in') +
                '">⇄</button>';
              html +=
                '<div class="court-player">' +
                '<span class="cp-name">' + mark + levelBadge(p) + ' ' + esc(p.name) + recordBadge(p) + '</span>' +
                swapBtn +
                '</div>';
            }
          });
          html += '</div>';
        });
      } else {
        // Open or partially filled: show any assigned players, then empty slots.
        c.players.forEach(function (p) {
          html +=
            '<div class="court-player">' + levelBadge(p) + ' ' + esc(p.name) +
            recordBadge(p) + '</div>';
        });
        for (var i = c.players.length; i < need; i++) {
          html += '<div class="court-empty-slot">empty slot</div>';
        }
      }
      html += '</div>';

      if (isFull) {
        html +=
          '<div class="court-timer" data-started="' + (c.startedAt || '') + '">' +
          '⏱ ' + formatElapsed(c.startedAt) + '</div>';

        ensureScore(c);
        var aLabel = state.singles ? 'A' : 'Side A';
        var bLabel = state.singles ? 'B' : 'Side B';
        var leadA = c.score.a > c.score.b;
        var leadB = c.score.b > c.score.a;
        html +=
          '<div class="scoreboard">' +
          '<div class="score-side">' +
          '<span class="score-name">' + aLabel + '</span>' +
          '<div class="score-controls">' +
          '<button class="score-btn" data-score="' + c.id + '" data-side="a" data-delta="-1">−</button>' +
          '<span class="score-val ' + (leadA ? 'lead' : '') + '">' + c.score.a + '</span>' +
          '<button class="score-btn" data-score="' + c.id + '" data-side="a" data-delta="1">+</button>' +
          '</div></div>' +
          '<span class="score-sep">:</span>' +
          '<div class="score-side">' +
          '<span class="score-name">' + bLabel + '</span>' +
          '<div class="score-controls">' +
          '<button class="score-btn" data-score="' + c.id + '" data-side="b" data-delta="-1">−</button>' +
          '<span class="score-val ' + (leadB ? 'lead' : '') + '">' + c.score.b + '</span>' +
          '<button class="score-btn" data-score="' + c.id + '" data-side="b" data-delta="1">+</button>' +
          '</div></div>' +
          '</div>';

        html +=
          '<div class="court-actions">' +
          '<button class="btn" data-finish="' + c.id + '">Finish game</button>' +
          '</div>';
        // Fallback manual win buttons (useful for a tie or a mis-scored game).
        html +=
          '<div class="court-actions win-fallback">' +
          '<button class="btn ghost small win-btn" data-finish="' + c.id + '" data-winner="a">A won</button>' +
          '<button class="btn ghost small win-btn" data-finish="' + c.id + '" data-winner="b">B won</button>' +
          '</div>';
      } else if (isPartial) {
        // Hand-picked but not full yet: prompt to finish the lineup.
        html +=
          '<div class="court-actions">' +
          '<button class="btn" data-edit="' + c.id + '">' +
          'Fill remaining (' + c.players.length + '/' + need + ')</button>' +
          '</div>';
      } else {
        // Standard courts start from the main queue. The challenge court
        // prefers challengers but falls back to the main queue when the
        // challenge queue can't fill it.
        var canAssign, startLabel, needLabel;
        if (chChallenge) {
          // Open challenge court with challengers waiting.
          canAssign = state.challengeQueue.length >= need;
          startLabel = 'Start next ' + need + ' challengers';
          needLabel = 'Need ' + need + ' challengers';
        } else {
          // Normal court, OR the challenge court idle (no challengers): it
          // proceeds on the main queue like any other court.
          canAssign = state.queue.length >= need;
          startLabel = 'Start next ' + need;
          needLabel = 'Need ' + need + ' players';
        }
        html +=
          '<div class="court-actions">' +
          '<button class="btn" data-assign="' + c.id + '"' +
          (canAssign ? '' : ' disabled') + '>' +
          (canAssign ? startLabel : needLabel) +
          '</button>' +
          '</div>';
      }

      // Edit button available on every court (open or in play).
      html +=
        '<div class="court-actions edit-row">' +
        '<button class="btn secondary small" data-edit="' + c.id + '">✎ Edit lineup</button>' +
        '</div>';

      html += '</div>';
    });
    el.courtsGrid.innerHTML = html;
  }

  // Inline lineup editor for one court: a dropdown per slot listing the
  // players available for that slot (queue players + this court's current
  // players), so you can hand-pick who plays.
  function renderCourtEditor(court, need) {
    // Players available to place: anyone in the line this court draws from
    // (challenge queue while actively a challenge game, else the main queue)
    // plus anyone already on THIS court. Sorted by name for easy scanning.
    var pool = playsAsChallenge(court) ? state.challengeQueue : state.queue;
    var available = pool.concat(court.players).slice();
    available.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    var current = court.players; // current occupant per slot (may be short)

    var html = '<div class="court-editor">';
    for (var slot = 0; slot < need; slot++) {
      var selId = current[slot] ? current[slot].id : '';
      var sideLabel = state.singles
        ? 'Player ' + (slot + 1)
        : (slot < need / 2 ? 'A' : 'B') + ' — slot ' + (slot + 1);
      html += '<label class="editor-slot">';
      html += '<span class="editor-slot-label">' + sideLabel + '</span>';
      html += '<select class="editor-select" data-slot="' + slot + '">';
      html += '<option value="">— empty —</option>';
      available.forEach(function (p) {
        var selected = String(p.id) === String(selId) ? ' selected' : '';
        html +=
          '<option value="' + p.id + '"' + selected + '>' +
          esc(p.name) + ' (' + (p.games || 0) + 'G)' +
          '</option>';
      });
      html += '</select></label>';
    }
    html +=
      '<div class="court-actions">' +
      '<button class="btn" data-save-lineup="' + court.id + '">Save lineup</button>' +
      '<button class="btn ghost" data-cancel-edit="1">Cancel</button>' +
      '</div>';
    html +=
      '<p class="editor-hint">Pick players for each slot. Leaving slots empty ' +
      'is fine. A game starts (and counts) once all slots are filled.</p>';
    html += '</div>';
    return html;
  }

  // Build standings from the MAIN-queue population only: players waiting in
  // the main queue plus those currently playing on NON-challenge courts.
  // The challenge queue and the challenge court (Court 1) are excluded.
  function renderStandings() {
    var everyone = state.queue.slice();
    state.courts.forEach(function (c) {
      // Exclude Court 1 only while it's actively running a challenge game.
      // When it's idle/falling back to the main queue, its players count.
      if (playsAsChallenge(c)) return;
      everyone = everyone.concat(c.players);
    });
    // De-dupe by id (a player is only ever in one place, but be safe).
    var seen = {};
    var players = [];
    everyone.forEach(function (p) {
      if (!seen[p.id]) {
        seen[p.id] = true;
        players.push(p);
      }
    });

    var ranked = players.filter(function (p) {
      return (p.wins || 0) + (p.losses || 0) > 0;
    });

    if (!ranked.length) {
      el.standingsList.innerHTML = '';
      el.standingsEmpty.hidden = false;
      return;
    }
    el.standingsEmpty.hidden = true;

    ranked.sort(function (a, b) {
      if ((b.wins || 0) !== (a.wins || 0)) return (b.wins || 0) - (a.wins || 0);
      if ((a.losses || 0) !== (b.losses || 0)) return (a.losses || 0) - (b.losses || 0);
      return a.name.localeCompare(b.name);
    });

    var html = '';
    ranked.forEach(function (p, i) {
      var medals = ['🥇', '🥈', '🥉'];
      var topClass = i < 3 ? ' top top' + (i + 1) : '';
      var rankMark = i < 3
        ? '<span class="standing-medal">' + medals[i] + '</span>'
        : '<span class="standing-rank">' + (i + 1) + '</span>';
      html +=
        '<li class="standing-item' + topClass + '">' +
        rankMark +
        '<span class="standing-name">' + esc(p.name) + '</span>' +
        '<span class="standing-record">' +
        '<b>' + (p.wins || 0) + '</b>W · ' + (p.losses || 0) + 'L</span>' +
        '</li>';
    });
    el.standingsList.innerHTML = html;
  }

  function renderHistory() {
    if (!state.history.length) {
      el.historyList.innerHTML = '';
      el.historyEmpty.hidden = false;
      return;
    }
    el.historyEmpty.hidden = true;

    var html = '';
    state.history.forEach(function (g) {
      var t = new Date(g.time).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      });
      var scoreTxt = (typeof g.winScore === 'number' && typeof g.loseScore === 'number')
        ? '<span class="history-score">' + g.winScore + '–' + g.loseScore + '</span>'
        : '';
      html +=
        '<li class="history-item">' +
        '<span class="history-time">' + t + '</span>' +
        '<span class="history-result">' +
        '<span class="won">' + esc(g.winners.join(' & ')) + '</span>' +
        '<span class="beat">def.</span>' +
        '<span class="lost">' + esc(g.losers.join(' & ')) + '</span>' +
        scoreTxt +
        '</span>' +
        '</li>';
    });
    el.historyList.innerHTML = html;
  }

  // The current holders of the challenge court and their live win streak,
  // plus the log of 3-in-a-row milestones.
  function renderChallengeReports() {
    // Live streak line (only while a team is actually holding the court).
    var streak = state.challengeStreak;
    var holdersOnCourt = false;
    var court0 = state.courts[0];
    if (court0 && streak.count > 0 && streak.ids.length) {
      var onCourtIds = court0.players.map(function (p) { return p.id; });
      holdersOnCourt = streak.ids.every(function (id) {
        return onCourtIds.indexOf(id) !== -1;
      });
    }
    if (holdersOnCourt) {
      el.challengeStreakNow.hidden = false;
      el.challengeStreakNow.innerHTML =
        '<span class="streak-flame">🔥</span>' +
        '<span class="streak-names">' + esc(streak.names.join(' & ')) + '</span>' +
        '<span class="streak-count">' + streak.count +
        (streak.count === 1 ? ' win' : ' wins') + ' in a row</span>';
    } else {
      el.challengeStreakNow.hidden = true;
      el.challengeStreakNow.innerHTML = '';
    }

    // Milestone report log.
    if (!state.challengeReports.length) {
      el.challengeReportList.innerHTML = '';
      el.challengeReportEmpty.hidden = false;
      return;
    }
    el.challengeReportEmpty.hidden = true;

    var html = '';
    state.challengeReports.forEach(function (r) {
      var t = new Date(r.time).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      });
      html +=
        '<li class="history-item report-item">' +
        '<span class="history-time">' + t + '</span>' +
        '<span class="history-result">' +
        '<span class="report-badge">🏆 ' + r.count + ' in a row</span>' +
        '<span class="won">' + esc(r.names.join(' & ')) + '</span>' +
        '</span>' +
        '</li>';
    });
    el.challengeReportList.innerHTML = html;
  }

  // Flash a dismissible banner when a team hits a 3-in-a-row milestone.
  function renderChallengeBanner() {
    if (!challengeFlash) {
      el.challengeBanner.hidden = true;
      return;
    }
    el.challengeBanner.hidden = false;
    el.challengeBanner.querySelector('.challenge-banner-text').innerHTML =
      '🏆 <b>' + esc(challengeFlash.names.join(' & ')) + '</b> won <b>' +
      challengeFlash.count + ' in a row</b> and were taken off rotation. ' +
      'Find them under “Checked out” and “Check in” to bring them back.';
  }

  function renderCheckedOut() {
    el.checkedOutCount.textContent = state.checkedOut.length;
    if (!state.checkedOut.length) {
      el.checkedOutList.innerHTML = '';
      el.checkedOutEmpty.hidden = false;
      return;
    }
    el.checkedOutEmpty.hidden = true;

    var html = '';
    state.checkedOut.forEach(function (p) {
      var span = (p.timeIn && p.timeOut)
        ? clockTime(p.timeIn) + ' → ' + clockTime(p.timeOut) +
          ' (' + durationText(p.timeIn, p.timeOut) + ')'
        : '';
      html +=
        '<li class="checkedout-item">' +
        levelBadge(p) +
        '<span class="co-name">' + esc(p.name) + '</span>' +
        '<span class="co-span" title="Checked in → out">' + span + '</span>' +
        '<span class="co-record" title="Record">' + recordText(p) + '</span>' +
        '<button class="btn secondary small" data-checkin="' + p.id + '">Check in</button>' +
        '<button class="icon-btn" data-remove-co="' + p.id + '" title="Remove from list">✕</button>' +
        '</li>';
    });
    el.checkedOutList.innerHTML = html;
  }

  function render() {
    el.singlesToggle.checked = state.singles;
    el.balanceToggle.checked = state.balance;
    el.autoStartToggle.checked = state.autoStart;
    el.skillBalanceToggle.checked = state.skillBalance;
    renderQueue();
    renderChallengeQueue();
    renderRaffle();
    renderCourts();
    renderStandings();
    renderHistory();
    renderChallengeReports();
    renderChallengeBanner();
    renderCheckedOut();
    var inPlay = state.courts.filter(function (c) {
      return c.players.length > 0;
    }).length;
    el.statusMeta.textContent =
      (state.singles ? 'Singles' : 'Doubles') + ' · ' +
      (state.balance ? 'Balanced' : 'Queue order') + ' · ' +
      (state.autoStart ? 'Auto-start on' : 'Manual start') + ' · ' +
      (state.skillBalance ? 'Skill-balanced' : 'Skill off') + ' · ' +
      inPlay + '/' + state.courts.length + ' courts in play';
  }

  // ---- Event wiring ---------------------------------------------------
  function wireEvents() {
    el.addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      addPlayer(el.playerName.value, el.playerLevel.value);
      el.playerName.value = '';
      el.playerName.focus();
    });

    el.shuffleQueueBtn.addEventListener('click', shuffleQueue);
    el.addCourtBtn.addEventListener('click', addCourt);
    el.removeCourtBtn.addEventListener('click', removeCourt);
    el.resetBtn.addEventListener('click', resetAll);
    el.singlesToggle.addEventListener('change', function (e) {
      setSingles(e.target.checked);
    });
    el.balanceToggle.addEventListener('change', function (e) {
      state.balance = e.target.checked;
      save();
      render();
    });
    el.autoStartToggle.addEventListener('change', function (e) {
      state.autoStart = e.target.checked;
      save();
      render();
    });
    el.skillBalanceToggle.addEventListener('change', function (e) {
      state.skillBalance = e.target.checked;
      save();
      render();
    });

    // Delegated clicks for dynamic queue/court buttons.
    el.queueList.addEventListener('click', function (e) {
      var partnerBtn = e.target.closest('[data-partner]');
      if (partnerBtn) {
        togglePartner(Number(partnerBtn.getAttribute('data-partner')));
        return;
      }
      var toChal = e.target.closest('[data-to-challenge]');
      if (toChal) {
        moveToChallenge(Number(toChal.getAttribute('data-to-challenge')));
        return;
      }
      var coBtn = e.target.closest('[data-checkout]');
      if (coBtn) {
        checkOut(Number(coBtn.getAttribute('data-checkout')));
        return;
      }
      var btn = e.target.closest('[data-remove]');
      if (btn) removeFromQueue(Number(btn.getAttribute('data-remove')));
    });

    // Delegated clicks for the challenge-queue items.
    el.challengeList.addEventListener('click', function (e) {
      var partnerBtn = e.target.closest('[data-partner]');
      if (partnerBtn) {
        togglePartner(Number(partnerBtn.getAttribute('data-partner')));
        return;
      }
      var toQ = e.target.closest('[data-to-queue]');
      if (toQ) {
        moveToQueue(Number(toQ.getAttribute('data-to-queue')));
        return;
      }
      var coBtn = e.target.closest('[data-co-challenge]');
      if (coBtn) {
        checkOut(Number(coBtn.getAttribute('data-co-challenge')));
        return;
      }
      var rm = e.target.closest('[data-remove-challenge]');
      if (rm) removeFromChallenge(Number(rm.getAttribute('data-remove-challenge')));
    });

    el.challengeForm.addEventListener('submit', function (e) {
      e.preventDefault();
      addChallenger(el.challengeName.value, el.challengeLevel.value);
      el.challengeName.value = '';
      el.challengeName.focus();
    });

    el.shuffleChallengeBtn.addEventListener('click', shuffleChallengeQueue);
    el.raffleDrawBtn.addEventListener('click', drawRaffle);
    el.raffleClearBtn.addEventListener('click', clearRaffle);

    el.prizeForm.addEventListener('submit', function (e) {
      e.preventDefault();
      addPrize(el.prizeName.value);
      el.prizeName.value = '';
      el.prizeName.focus();
    });
    el.prizeList.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-remove-prize]');
      if (rm) removePrize(Number(rm.getAttribute('data-remove-prize')));
    });

    el.challengeBannerDismiss.addEventListener('click', function () {
      challengeFlash = null;
      renderChallengeBanner();
    });

    el.checkedOutList.addEventListener('click', function (e) {
      var inBtn = e.target.closest('[data-checkin]');
      if (inBtn) {
        checkIn(Number(inBtn.getAttribute('data-checkin')));
        return;
      }
      var rm = e.target.closest('[data-remove-co]');
      if (rm) removeCheckedOut(Number(rm.getAttribute('data-remove-co')));
    });

    el.courtsGrid.addEventListener('click', function (e) {
      var assign = e.target.closest('[data-assign]');
      if (assign) {
        assignCourt(Number(assign.getAttribute('data-assign')));
        return;
      }
      var openSw = e.target.closest('[data-open-swap-court]');
      if (openSw) {
        openSwap(
          Number(openSw.getAttribute('data-open-swap-court')),
          Number(openSw.getAttribute('data-open-swap-player'))
        );
        return;
      }
      var cancelSw = e.target.closest('[data-cancel-swap]');
      if (cancelSw) {
        cancelSwap();
        return;
      }
      var scoreBtn = e.target.closest('[data-score]');
      if (scoreBtn) {
        adjustScore(
          Number(scoreBtn.getAttribute('data-score')),
          scoreBtn.getAttribute('data-side'),
          Number(scoreBtn.getAttribute('data-delta'))
        );
        return;
      }
      var finish = e.target.closest('[data-finish]');
      if (finish) {
        finishCourt(
          Number(finish.getAttribute('data-finish')),
          finish.getAttribute('data-winner') || undefined
        );
        return;
      }
      var edit = e.target.closest('[data-edit]');
      if (edit) {
        startEdit(Number(edit.getAttribute('data-edit')));
        return;
      }
      var cancel = e.target.closest('[data-cancel-edit]');
      if (cancel) {
        cancelEdit();
        return;
      }
      var saveBtn = e.target.closest('[data-save-lineup]');
      if (saveBtn) {
        var courtId = Number(saveBtn.getAttribute('data-save-lineup'));
        var courtEl = saveBtn.closest('.court');
        var selects = courtEl.querySelectorAll('.editor-select');
        var slotIds = [];
        selects.forEach(function (sel) {
          slotIds.push(sel.value);
        });
        saveLineup(courtId, slotIds);
      }
    });

    // Choosing a player in the inline swap picker performs the switch.
    el.courtsGrid.addEventListener('change', function (e) {
      var sel = e.target.closest('.swap-select');
      if (!sel) return;
      var incomingId = sel.value;
      if (!incomingId) return;
      swapPlayerWith(
        Number(sel.getAttribute('data-swap-court')),
        Number(sel.getAttribute('data-swap-player')),
        Number(incomingId)
      );
    });
  }

  // Live-update on-court timers and queue wait times once a second, without
  // a full re-render.
  function tickTimers() {
    el.courtsGrid.querySelectorAll('.court-timer[data-started]').forEach(function (node) {
      var started = Number(node.getAttribute('data-started'));
      if (started) node.textContent = '⏱ ' + formatElapsed(started);
    });
    var waitNodes = el.queueList.querySelectorAll('.wait-badge[data-waiting]');
    el.challengeList.querySelectorAll('.wait-badge[data-waiting]').forEach(function (n) {
      var since = Number(n.getAttribute('data-waiting'));
      if (since) n.textContent = '⏱ ' + formatElapsed(since);
    });
    waitNodes.forEach(function (node) {
      var since = Number(node.getAttribute('data-waiting'));
      if (since) node.textContent = '⏱ ' + formatElapsed(since);
    });
  }

  // ---- Init -----------------------------------------------------------
  function init() {
    cacheDom();
    var had = load();
    if (!had) {
      // First run: seed with 2 courts so it's usable immediately.
      state.courts.push({ id: newId(), players: [], startedAt: null, score: { a: 0, b: 0 }, challengeGame: false });
      state.courts.push({ id: newId(), players: [], startedAt: null, score: { a: 0, b: 0 }, challengeGame: false });
      // Seed a few example raffle prizes so the list is usable immediately.
      ['Free drink', 'New grip tape', 'Pickleball set', 'Bragging rights'].forEach(function (label) {
        state.prizes.push({ id: newId(), label: label });
      });
      save();
    }
    wireEvents();
    render();
    setInterval(tickTimers, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
