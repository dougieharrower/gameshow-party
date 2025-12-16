Game State Transitions

This document defines how the game progresses between states on the Big Screen (Host) and Player Phones, including what triggers each transition and who controls it.

The server is authoritative at all times.

Core Principles

The server owns:

Game state

Timing

Scoring

Clients (big screen + phones):

Render state sent by server

Send player intent only

Phones never advance state on their own

All transitions are driven by:

Server timers

Server validation of player actions

Host action (start game / next round)

Global State Diagram (High-Level)
IDLE
 → LOBBY
 → ROUND_1_FASTEST_CORRECT
 → ROUND_2_TRIANGULATE
 → ROUND_3_FINAL
 → GAME_OVER

1. Lobby Flow
State: LOBBY_WAITING

Big Screen

Shows room code

Displays joined players

Phones

Show “Waiting for game to start”

Transitions

Trigger: Host clicks Start Game

Server validates minimum players

→ ROUND_1_INTRO

2. Round 1 – Fastest Correct
State: ROUND_1_INTRO

Big Screen

“Round 1 – Fastest Correct”

Short intro animation

Phones

“Get ready”

Transition

Auto-advance after intro timer

→ ROUND_1_QUESTION

State: ROUND_1_QUESTION

Big Screen

Shows question + A/B/C/D

Phones

Show BUZZ button (initially disabled)

Transition

Server opens buzz window

→ ROUND_1_BUZZ_OPEN

State: ROUND_1_BUZZ_OPEN

Phones

BUZZ enabled

Server

Records buzz order (server timestamp)

First buzzed player transitions to answer state

Transitions

On first buzz → that player → ROUND_1_ANSWER

Others remain waiting

Buzz window timeout → skip question → reveal

State: ROUND_1_ANSWER

Phones (buzzed player)

Show A/B/C/D buttons

Server

Awaits answer or timeout

Transitions

Correct answer → ROUND_1_REVEAL

Wrong answer → next buzzed player → ROUND_1_ANSWER

No valid answers → ROUND_1_REVEAL

State: ROUND_1_REVEAL

Big Screen

Reveals correct answer

Updates scores

Phones

Brief feedback (“Correct” / “Wrong”)

Transitions

If more questions in set → ROUND_1_QUESTION

Else → ROUND_2_INTRO

3. Round 2 – Triangulate
State: ROUND_2_INTRO

Big Screen

“Round 2 – Triangulate”

Phones

“Place your pin on the map”

Transition

Auto after intro timer

→ ROUND_2_PLACE_PINS

State: ROUND_2_PLACE_PINS

Phones

Map view

Players place required number of pins

Lock In button

Server

Tracks per-player pin count

Auto-locks at timer end

Transitions

All players locked OR timer expires

→ ROUND_2_RESOLVE

State: ROUND_2_RESOLVE

Server

Builds regions (triangle / circle / point)

Calculates score

Big Screen

Shows regions

Reveals target

Animates scoring

Phones

“Waiting for results…”

Transition

After reveal animation

→ ROUND_3_INTRO

4. Round 3 – Final Podium
State: ROUND_3_INTRO

Big Screen

“Final Round – Podium”

Phones

“Stay above zero”

Server

Converts scores → starting heights

Transition

Auto

→ ROUND_3_QUESTION

State: ROUND_3_QUESTION

Big Screen

Shows question + A/B/C/D

Phones

Show A/B/C/D

Timer visible

Server

Accepts answers with timestamps

Transition

Timer expires OR all answers received

→ ROUND_3_RESOLVE

State: ROUND_3_RESOLVE

Server

Determines:

First correct answer

Rank-based height boost

Height drops for wrong answers

Eliminates players at height ≤ 0

Big Screen

Boost animation

Podium drops

Elimination collapse

Phones

Feedback:

“Safe”

“Dropped”

“Eliminated”

Transitions

If >2 players remain → ROUND_3_QUESTION

If 2 players remain → ROUND_3_COUNTDOWN

If 1 player remains → GAME_OVER

State: ROUND_3_COUNTDOWN

Server

Starts fixed question countdown (e.g. 5 questions)

Rules

No eliminations mid-question

Heights still change

Transition

Countdown complete

→ winner by height

If tied → ROUND_3_SUDDEN_DEATH

State: ROUND_3_SUDDEN_DEATH

Big Screen

One final question

Phones

A/B/C/D

Rule

First correct answer wins

Transition

→ GAME_OVER

5. Game Over
State: GAME_OVER

Big Screen

Winner screen

“Play again?”

Phones

Winner / spectator screens

Transition

Host selects:

Play again → LOBBY_WAITING

End session → IDLE

Failure & Edge Handling
Player Disconnect

Player remains in game

Inputs ignored

Counts as:

No buzz

No answer

No pin (auto-placed)

AFK Player

Auto-lock on timers

Natural penalties apply

Latency

Server timestamps all actions

Client timestamps are advisory only
