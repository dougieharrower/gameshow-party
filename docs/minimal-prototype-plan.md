# Minimal Prototype Plan (v0.1)

This document defines the **smallest playable version** of the game that proves the core idea works.

The goal is **not polish**, **not completeness**, and **not scalability** — the goal is to validate:

* Real-time multi-device play
* Fair timing
* Clear game flow
* Fun factor

---

## Prototype Goals

The v0.1 prototype should prove:

* Players can reliably join a room from their phones
* A shared big screen updates in real time
* Phones can submit inputs that affect the game
* The server correctly resolves timing and scoring

If these work, everything else is incremental.

---

## Scope (What IS Included)

### Core Systems

* Room creation
* Room code join flow
* Player list syncing
* Authoritative server state
* WebSocket messaging

### Supported Clients

* **Big Screen**: desktop browser (fullscreen)
* **Phone**: mobile browser

---

## Scope (What Is NOT Included)

Explicitly excluded from v0.1:

* Teams
* Triangulate geometry scoring
* Category selection UI
* Animations
* Sound
* Host moderation tools
* Reconnect handling beyond basic refresh

These are intentionally deferred.

---

## Rounds Implemented in v0.1

### Round 1 – Fastest Correct (FULLY IMPLEMENTED)

This round is the backbone of the prototype.

**Why**:

* Uses all core interactions (buzz + answer)
* Tests latency handling
* Tests server authority

**Features**:

* Fixed set of multiple-choice questions
* Buzz-in mechanic
* A/B/C/D answering
* Scoring updates
* Simple score display

---

### Round 3 – Final Podium (SIMPLIFIED)

Implemented in a reduced form.

**Included**:

* Convert scores to podium height
* A/B/C/D answering
* Height reduction on wrong answers
* Winner determination

**Simplifications**:

* No rank-based boost scaling
* No countdown mode
* No sudden death

---

### Round 2 – Triangulate (STUB ONLY)

Included only as a placeholder.

**Behavior**:

* Big screen shows "Triangulate (Coming Soon)"
* Phones show waiting screen
* After timer, round auto-completes

Purpose: prove round sequencing works.

---

## Game Flow (v0.1)

```
Lobby
 → Round 1: Fastest Correct (5–7 questions)
 → Round 2: Triangulate (stub)
 → Round 3: Final Podium (simplified)
 → Game Over
```

---

## Minimal UI Requirements

### Big Screen

* Room code display
* Player list
* Current state label (debug-visible)
* Question text
* A/B/C/D labels
* Simple score bars
* Podium bars for final round

Visuals can be plain HTML/CSS.

---

### Phone Client

* Join screen
* Name entry
* Waiting screen
* Buzz button
* A/B/C/D buttons
* Feedback text (Correct / Wrong / Eliminated)

No animations required.

---

## Content Requirements

* 10–15 multiple-choice questions
* 2–3 categories (hard-coded is fine)
* All content loaded from static JSON

---

## Success Criteria

The prototype is successful if:

* 3–6 players can complete a full game
* Inputs feel responsive and fair
* No desyncs occur during play
* Players understand what is happening without explanation
* The game feels "fun enough" to want iteration

---

## Failure Criteria

The prototype has failed if:

* Buzz timing feels unfair
* Players are confused about what to do
* Phones lag noticeably behind the big screen
* State transitions break or stall

---

## Recommended Tech (Non-Binding)

* Node.js server
* WebSockets or Socket.IO
* In-memory game state
* Static HTML clients

No database required.

---

## Post-Prototype Next Steps

Once v0.1 is successful:

1. Proper Triangulate implementation
2. Category selection UI
3. Better final-round balancing
4. Animations and sound
5. Reconnect handling
6. Content tooling

---

## Summary

v0.1 exists to answer one question:

> *Is this fun and technically viable?*

If yes, everything else is iteration.
