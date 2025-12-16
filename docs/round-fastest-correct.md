# Round 1 – Fastest Correct

## Overview

Fastest Correct is a high-energy, reflex-based opening round designed to:
- Warm up players
- Teach core controls (buzzing and A/B/C/D answers)
- Establish an initial score spread without runaway leaders

This round prioritizes **speed and accuracy**, with minimal reading on player devices.

---

## Core Mechanics

- Multiple choice questions (A / B / C / D)
- Players buzz in to earn the right to answer
- Only one player answers at a time
- The first correct answer scores

Phones display **letters only**; all answer text appears on the big screen.

---

## Round Structure

- Round consists of multiple questions
- Questions are grouped by category
- First category is fixed
- Subsequent categories are chosen by the current last-place player

---

## Question Flow

1. Question and answers appear on the big screen
2. Phones show **BUZZ** button (initially disabled)
3. Server opens buzz window
4. Players buzz in
5. Buzzed player selects A / B / C / D
6. Server evaluates answer
7. Reveal and scoring animation
8. Next question or category selection

---

## Category Selection

- After a set number of questions, the **last-place player** selects the next category
- Categories are presented as A / B / C / D
- If players are tied for last:
  - Tie is broken by slowest average buzz time
  - If still tied, selection is random

---

## Scoring (Suggested)

- First correct answer: +100
- Second correct answer (after a miss): +70
- Third correct answer: +40
- Incorrect answer: −30

(Exact values are tunable.)

---

## Timing

- Buzz window: 8–10 seconds
- Answer selection window: 5 seconds
- Auto-advance on timeout to prevent dead air

---

## Edge Cases

- No buzzes → question times out, no score change
- Player disconnects → skipped for buzzing
- AFK players simply miss opportunities

---

## Design Notes

- Phones never display answer text
- Server timestamps resolve all buzz ties
- This round should feel fast, slightly chaotic, and forgiving
