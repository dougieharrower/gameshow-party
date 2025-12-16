# Content Format

This document defines the structure and format for all game content, including questions, categories, and map prompts.

The goal is to allow new content to be added **without changing game code**.

---

## Core Principles

* Content is data, not logic
* All content is versionable and portable
* IDs are stable and unique
* Clients never infer correctness; server validates

---

## Content Types

The game uses three primary content types:

1. **Multiple-choice questions** (Rounds 1 and 3)
2. **Map-based prompts** (Round 2 – Triangulate)
3. **Category packs** (used for sequencing and selection)

---

## Multiple-Choice Question Format

Used in:

* Round 1 – Fastest Correct
* Round 3 – Final Podium

### Schema

```json
{
  "questionId": "q_general_001",
  "rounds": [1, 3],
  "categoryId": "general",
  "prompt": "Which is the capital of Canada?",
  "answers": {
    "A": "Toronto",
    "B": "Ottawa",
    "C": "Vancouver",
    "D": "Montreal"
  },
  "correctChoice": "B",
  "difficulty": 2,
  "timeLimitMs": 10000
}
```

### Field Notes

* `questionId` must be globally unique
* `rounds` indicates which rounds may use this question
* `answers` keys must always be `A`, `B`, `C`, `D`
* `correctChoice` is never sent to clients
* `difficulty` is a relative scale (1–5)
* `timeLimitMs` may override default round timing

---

## Category Format

Categories group multiple-choice questions and are used for:

* Thematic grouping
* Category selection by players

### Schema

```json
{
  "categoryId": "general",
  "displayName": "General Knowledge",
  "description": "A mix of widely known facts",
  "questionIds": [
    "q_general_001",
    "q_general_002",
    "q_general_003"
  ]
}
```

### Rules

* Categories should contain more questions than needed in a single game
* Question order should be randomized per game
* Categories may be reused across sessions

---

## Category Selection Packs

Used in Round 1 when players select the next category.

### Schema

```json
{
  "packId": "r1_pack_01",
  "round": 1,
  "categoryOptions": [
    "general",
    "history",
    "science",
    "pop_culture"
  ]
}
```

### Notes

* Packs allow curated sets of options
* Packs can be swapped without code changes
* Display order may be randomized

---

## Map Prompt Format (Triangulate)

Used exclusively in Round 2.

### Schema

```json
{
  "promptId": "map_001",
  "prompt": "Where did this historical event take place?",
  "map": {
    "mapId": "world_basic",
    "center": { "lat": 20.0, "lng": 0.0 },
    "zoom": 2
  },
  "target": { "lat": 48.8566, "lng": 2.3522 },
  "difficulty": 3,
  "placementTimeMs": 20000
}
```

### Field Notes

* `target` is server-only
* `mapId` corresponds to a predefined map style
* Prompts should not require exact precision

---

## Difficulty Guidelines

Difficulty is a **relative scale** used for:

* Content mixing
* Adaptive pacing (future)

Suggested interpretation:

* `1` – Very easy, common knowledge
* `2` – Easy
* `3` – Moderate
* `4` – Hard
* `5` – Very hard / niche

---

## Content Packs

Content should be stored and loaded in packs.

### Example Pack

```json
{
  "packId": "base_pack_v1",
  "version": "1.0",
  "categories": ["general", "history", "science"],
  "questions": ["q_general_001", "q_history_002"],
  "mapPrompts": ["map_001", "map_002"]
}
```

---

## Validation Rules (Server)

The server must validate:

* All IDs exist
* Questions are eligible for the current round
* Answers are one of A/B/C/D
* Content is not reused improperly within a game

---

## Design Notes

* Content files should be pure JSON
* Localization can be added by externalizing `prompt` and `answers`
* IDs should never change once published

---

## Future Extensions

* Media attachments (images, audio)
* Weighted category selection
* Difficulty-based matchmaking
* User-generated content
