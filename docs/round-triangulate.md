# Round 2 – Triangulate

## Overview

Triangulate is a slower, strategic team round that contrasts with Round 1 by focusing on:
- Spatial reasoning
- Collaboration
- Risk vs confidence

Players define a **confidence zone** on a map rather than guessing a precise point.

---

## Core Concept

> “Draw how confident you are.”

Pins placed by players define a geometric region.  
Smaller, accurate regions score higher than larger, safer ones.

---

## Question Type

Each question asks players to locate a target on a map, such as:
- A historical event
- A real-world location
- The likely habitat of something
- Where a photo was taken

Avoid trivia that reduces to simple fact recall.

---

## Team Configurations

Triangulate automatically adapts to player count.

### 3 vs 3
- Each player places one pin
- Pins form a triangle
- Target inside triangle = high score
- Smaller triangle = higher score

### 2 vs 2
- Each player places one pin
- Pins define a circle using the two points as a diameter

### 2 vs 1
- Both sides create circles
- Team of two: one pin per player
- Solo player: places two pins

### 1 vs 1
- Each player places one pin
- Score based purely on distance

---

## Pin Placement Phase

- Players place required number of pins on their phone
- Pins can be adjusted until locked
- Auto-lock occurs when timer expires

---

## Resolution Phase

1. Server constructs regions (triangle / circle / point)
2. Target location is revealed
3. Regions are scored independently
4. Scores are awarded based on:
   - Whether target is inside region
   - Size of region
   - Distance from region if outside

---

## Scoring Model (Conceptual)

- Inside region → high base score
- Smaller region → higher multiplier
- Outside region → exponential decay by distance
- No negative scores

Exact formulas are implementation details.

---

## Timing

- Placement phase: ~20 seconds
- Reveal phase paced for drama

---

## Edge Cases

- AFK player → pin auto-placed at map center
- Overlapping regions allowed
- Ties resolved by smaller region size

---

## Design Notes

- All regions are semi-transparent
- Geometry is secondary to readability
- This round naturally rebalances scores without artificial handicaps
