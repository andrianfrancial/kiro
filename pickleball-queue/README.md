# Pickleball Queue

A no-build website app for managing open-play pickleball: players wait in a
queue, get assigned to open courts, and rotate to the back of the line when
their game finishes.

Runs entirely in your browser. No install, no Node, no build step. Your queue
and courts are saved locally on the device (localStorage), so they survive a
page refresh.

## Run it

Open `index.html` in any modern browser (double-click it, or drag it into a
tab). It starts with two open courts ready to go.

## How it works

1. **Add players** — type a name, pick a skill level (**Novice**,
   **Intermediate**, or **Advanced**), and hit **+ Add**. They join the bottom
   of the waiting queue with a colored level badge (NOV / INT / ADV) shown
   everywhere their name appears.
2. **Set your courts** — use **+ Court** / **− Court** to match how many courts
   you actually have.
3. **Start a game** — on any open court, click **Start next 4** (or **Start
   next 2** in singles). The app pulls the next players off the top of the queue
   and puts them on that court, and starts a timer.
4. **Finish a game & record the winner** — each court is split into **Side A**
   (top players) and **Side B** (bottom players). When the game ends, click
   **A won** or **B won** (in singles the buttons show the players' names). The
   winning side gets a win, the losing side gets a loss, the result is logged,
   and the four players return to the queue, after which the **entire waiting
   queue is shuffled into a random order** regardless of who won or lost.

You can also shuffle the queue any time with the **🔀 Shuffle** button in the
Waiting Queue header.

## Pairing partners (doubles)

Each queued player has a **🤝** button to lock two players together as a
doubles team:

- Click **🤝** on one player (it arms, highlighted), then click **🤝** on
  another to pair them. Their names show a **🤝 with …** tag.
- Click **🤝** on a paired player to unpair; clicking the armed player again
  cancels.
- Partners are pulled onto a court **together** and placed on the **same
  side**, so they never get split across sides or courts.
- Pairing **persists** across games until you unpair (or remove a player).
- Partners only apply in **doubles**; the button is inactive in singles.

## Manually setting a court lineup

Every court has an **✎ Edit lineup** button. Click it to hand-pick who plays:

- Each slot becomes a dropdown of available players (everyone in the queue plus
  whoever is already on that court), with their games count shown.
- **Save lineup** pulls the chosen players onto the court and sends anyone you
  removed back to the queue. A player can't be on two courts at once.
- Fill every slot and the game starts (timer runs, games counted). Leave slots
  empty and the court shows as **Filling** until you complete it.
- You can edit a court that's already in play to **swap a player** without
  resetting the timer or double-counting games.

For a quick single swap, each player on an in-play court has a **⇄** button.
Click it and a dropdown appears listing everyone waiting; pick who should come
in and they take that exact slot, keeping the same side, timer, and score. The
player they replace goes back to the queue. The button is disabled when no one
is waiting.

The next players who would fill an open court are tagged **up next** in the
queue so everyone can see who's on deck. Each waiting player also shows a live
**wait timer** (⏱) that counts how long they've been in the queue; it resets
whenever they come off a court and rejoin the line.

## Balancing sides by skill

With **Balance skill** on (default), when a court fills with four players the
app splits them into the two most evenly-matched sides using skill weights
(Novice 1, Intermediate 2, Advanced 3). It picks the 2-2 split whose side
totals are closest, so games stay competitive.

- This only arranges the **sides within a court** — it doesn't change who gets
  picked (that stays games-fair and partner-aware).
- **Partnered** players always stay on the same side; skill-balancing works
  around fixed pairs.
- Turn the toggle off to keep players in plain pick order.

## Scoring a game

Each in-play court shows a **scoreboard** for Side A and Side B. Use the
**+ / −** buttons to track points as the game goes; the leading side is
highlighted.

- **Finish game** records the higher-scoring side as the winner and logs the
  final score.
- On a tie it asks you to adjust the score or use the **A won / B won** fallback
  buttons.
- Scores reset to 0–0 when a court starts a new game and are saved with the rest
  of the state.

## Winners, losers &amp; standings

- Every player carries a **W-L record** shown next to their name in the queue
  and on court (e.g. `2-1`).
- **Standings** rank everyone by wins, then fewest losses.
- **Recent results** logs each finished game (winners def. losers) with a
  timestamp.
- All of this persists locally and clears with **Reset all**.

## Doubles vs singles

- Defaults to **doubles** (4 players per court).
- Flip the **Singles (2 per court)** toggle at the top to switch.
- You can only switch modes when no games are in progress, so a court never
  ends up half-filled under the new size.

## Check-in / check-out (attendance)

Every player gets a **check-in time** stamped when you add them, shown as
"in 6:30 PM" in the queue.

- Click the **⏻** button on a queued player to **check them out**: their
  departure time is recorded and they move to the **Checked out** list, which
  shows `6:30 PM → 7:45 PM (1h 15m)` and their W-L record.
- Click **Check in** on anyone in that list to bring them back to the queue
  (fresh arrival time, stats preserved).
- **✕** in the checked-out list removes them from the record entirely.

## Other controls

- **✕** next to a queued player removes them from the queue.
- **− Court** removes the last court; if a game is on it, you'll be asked to
  confirm and its players go back to the queue.
- **Reset all** clears everything (asks first).

## Files

| File         | Purpose                                              |
| ------------ | ---------------------------------------------------- |
| `index.html` | Page structure.                                      |
| `styles.css` | Styling.                                             |
| `app.js`     | Queue/court state, persistence, and all the logic.   |

## Notes

- Data lives only in this browser on this device. Opening the app on a
  different device or browser starts fresh.
- To reset from scratch, use **Reset all** (or clear the site's storage).
