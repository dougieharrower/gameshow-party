# Game Show Party

A smartphone-controlled party game played on a shared screen, with players joining on their phones as controllers.

## Where we are

* **Server:** Express + Socket.IO (rooms, state, scoring, timers)
* **Host UI:** create room, start/end game, see players/scores, basic Round 1 HUD
* **Phone UI:** join + rejoin (localStorage token), category pick, answer buttons
* **Content:** JSON-driven categories + questions

## Current MVP: Round 1 (Fastest Finger)

Fastest Finger is the first working round.

How it plays:

* Questions are multiple choice (A/B/C/D).
* Everyone can answer immediately.
* **First correct tap wins** and the game moves to the next question.
* Wrong taps **lock that player out** for the rest of the question.
* If time runs out with no winner, players who **did not attempt** get a timeout penalty.

Round structure:

* **4 blocks**
* **6 questions per block**
* Block 1 is always **General**
* After each block, the player in last place picks the next category (blocks 2–4)

## Project structure

* `server/index.js` — server, rooms/state, scoring, timers, content loading
* `web/host/index.html` — host screen UI
* `web/phone/index.html` — phone controller UI
* `content/` — categories and questions JSON

## Content format

### `content/categories.v1.json`

Provides category IDs and display names.

### `content/questions.*.json`

Any file under `content/` that starts with `questions.` and ends with `.json` (or `.v1.json`) will be loaded.

Each file should export an array of questions:

```json
[
  {
    "id": "geo_001",
    "categoryId": "geography",
    "prompt": "Which is the largest continent?",
    "answers": ["Asia", "Africa", "Europe", "Antarctica"],
    "correct": "A",
    "timeLimitMs": 5000
  }
]
```

Notes:

* `answers` can be either:

  * an array: `["..."]`, or
  * an object: `{ "A": "...", "B": "...", "C": "...", "D": "..." }`
* `correct` should be one of: `A`, `B`, `C`, `D`
* `timeLimitMs` is optional (defaults to 5000ms)

## Running locally

```bash
npm install
node server/index.js
```

Open:

* Host: `http://localhost:3000/host`
* Phone: `http://localhost:3000/phone`

## What’s next

### Countdown UI

We already have server-authoritative deadlines (epoch `endsAt`) for:

* category selection (auto-pick window)
* question timer (time left to win)

Next step is to render those countdowns on both host and phone screens and keep them updating live.

### Theming pass

Once timers are visible and stable, the next milestone is a light theme pass (layout, typography, spacing) while keeping the UI simple.

### More rounds

Planned MVP rounds after Round 1:

* Triangulate
* Final Podium
