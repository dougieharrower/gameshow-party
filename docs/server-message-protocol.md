# Server Message Protocol

This document defines the real-time message protocol between the **Host (Big Screen)**, **Player Phones**, and the **Server**.

The server is authoritative for **state, timing, scoring, and validation**.

---

## Core Principles

* All messages are JSON
* Communication is bidirectional (WebSockets recommended)
* Clients send **intent only**
* Server resolves outcomes and broadcasts results

---

## Message Envelope

All messages follow this structure:

```json
{
  "type": "string",
  "roomCode": "ABCD",
  "clientTime": 1730000000000,
  "payload": {}
}
```

Server responses include `serverTime`:

```json
{
  "type": "string",
  "roomCode": "ABCD",
  "serverTime": 1730000000123,
  "payload": {}
}
```

---

## Roles

### Host Client

* Creates room
* Starts game
* Renders authoritative state

### Phone Client

* Joins room
* Submits buzzes, answers, pin placements
* Renders server state

### Server

* Manages rooms and players
* Enforces game state
* Runs timers
* Calculates scores and eliminations

---

## Lobby Messages

### host:create_room

```json
{
  "type": "host:create_room",
  "payload": { "maxPlayers": 6 }
}
```

### server:room_created

```json
{
  "type": "server:room_created",
  "payload": { "roomCode": "CAPE", "maxPlayers": 6 }
}
```

### phone:join_room

```json
{
  "type": "phone:join_room",
  "roomCode": "CAPE",
  "payload": {
    "displayName": "Dougie",
    "avatarId": "emoji_hedgehog"
  }
}
```

### server:join_accepted

```json
{
  "type": "server:join_accepted",
  "payload": {
    "playerId": "p_93b2",
    "displayName": "Dougie",
    "avatarId": "emoji_hedgehog"
  }
}
```

### server:player_list_updated

```json
{
  "type": "server:player_list_updated",
  "payload": {
    "players": [
      { "playerId": "p_93b2", "displayName": "Dougie" }
    ]
  }
}
```

---

## State Control

### server:state_changed

```json
{
  "type": "server:state_changed",
  "payload": {
    "state": "ROUND_1_INTRO",
    "roundId": 1
  }
}
```

---

## Timers

### server:timer_started

```json
{
  "type": "server:timer_started",
  "payload": {
    "timerId": "t_r1_q1",
    "durationMs": 10000,
    "serverStartTime": 1730000000123
  }
}
```

### server:timer_ended

```json
{
  "type": "server:timer_ended",
  "payload": { "timerId": "t_r1_q1" }
}
```

---

## Round 1 – Fastest Correct

### server:r1_question_presented

```json
{
  "type": "server:r1_question_presented",
  "payload": {
    "questionId": "q_001",
    "prompt": "Which is the capital of Canada?",
    "answers": { "A": "Toronto", "B": "Ottawa", "C": "Vancouver", "D": "Montreal" }
  }
}
```

### server:r1_buzz_open

```json
{
  "type": "server:r1_buzz_open",
  "payload": { "questionId": "q_001" }
}
```

### phone:r1_buzz

```json
{
  "type": "phone:r1_buzz",
  "payload": { "playerId": "p_93b2", "questionId": "q_001" }
}
```

### phone:r1_answer_selected

```json
{
  "type": "phone:r1_answer_selected",
  "payload": { "playerId": "p_93b2", "choice": "B" }
}
```

### server:r1_reveal

```json
{
  "type": "server:r1_reveal",
  "payload": {
    "correctChoice": "B",
    "scores": [
      { "playerId": "p_93b2", "score": 200 }
    ]
  }
}
```

---

## Round 2 – Triangulate

### phone:r2_pin_drop

```json
{
  "type": "phone:r2_pin_drop",
  "payload": {
    "playerId": "p_93b2",
    "lat": 41.9,
    "lng": 12.5
  }
}
```

### phone:r2_pin_lock

```json
{
  "type": "phone:r2_pin_lock",
  "payload": { "playerId": "p_93b2" }
}
```

### server:r2_reveal

```json
{
  "type": "server:r2_reveal",
  "payload": {
    "target": { "lat": 48.85, "lng": 2.35 },
    "scores": [
      { "playerId": "p_93b2", "score": 280 }
    ]
  }
}
```

---

## Round 3 – Final Podium

### server:r3_setup

```json
{
  "type": "server:r3_setup",
  "payload": {
    "heights": [
      { "playerId": "p_93b2", "height": 100 }
    ]
  }
}
```

### phone:r3_answer_selected

```json
{
  "type": "phone:r3_answer_selected",
  "payload": { "playerId": "p_93b2", "choice": "C" }
}
```

### server:r3_resolution

```json
{
  "type": "server:r3_resolution",
  "payload": {
    "correctChoice": "C",
    "heights": [
      { "playerId": "p_93b2", "height": 85 }
    ]
  }
}
```

---

## Game Over

### server:game_over

```json
{
  "type": "server:game_over",
  "payload": {
    "winnerPlayerId": "p_93b2"
  }
}
```
