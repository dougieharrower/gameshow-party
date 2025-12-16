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

&nbsp;→ LOBBY

&nbsp;→ ROUND\_1\_FASTEST\_CORRECT

&nbsp;→ ROUND\_2\_TRIANGULATE

&nbsp;→ ROUND\_3\_FINAL

&nbsp;→ GAME\_OVER



1\. Lobby Flow

State: LOBBY\_WAITING



Big Screen



Shows room code



Displays joined players



Phones



Show “Waiting for game to start”



Transitions



Trigger: Host clicks Start Game



Server validates minimum players



→ ROUND\_1\_INTRO



2\. Round 1 – Fastest Correct

State: ROUND\_1\_INTRO



Big Screen



“Round 1 – Fastest Correct”



Short intro animation



Phones



“Get ready”



Transition



Auto-advance after intro timer



→ ROUND\_1\_QUESTION



State: ROUND\_1\_QUESTION



Big Screen



Shows question + A/B/C/D



Phones



Show BUZZ button (initially disabled)



Transition



Server opens buzz window



→ ROUND\_1\_BUZZ\_OPEN



State: ROUND\_1\_BUZZ\_OPEN



Phones



BUZZ enabled



Server



Records buzz order (server timestamp)



First buzzed player transitions to answer state



Transitions



On first buzz → that player → ROUND\_1\_ANSWER



Others remain waiting



Buzz window timeout → skip question → reveal



State: ROUND\_1\_ANSWER



Phones (buzzed player)



Show A/B/C/D buttons



Server



Awaits answer or timeout



Transitions



Correct answer → ROUND\_1\_REVEAL



Wrong answer → next buzzed player → ROUND\_1\_ANSWER



No valid answers → ROUND\_1\_REVEAL



State: ROUND\_1\_REVEAL



Big Screen



Reveals correct answer



Updates scores



Phones



Brief feedback (“Correct” / “Wrong”)



Transitions



If more questions in set → ROUND\_1\_QUESTION



Else → ROUND\_2\_INTRO



3\. Round 2 – Triangulate

State: ROUND\_2\_INTRO



Big Screen



“Round 2 – Triangulate”



Phones



“Place your pin on the map”



Transition



Auto after intro timer



→ ROUND\_2\_PLACE\_PINS



State: ROUND\_2\_PLACE\_PINS



Phones



Map view



Players place required number of pins



Lock In button



Server



Tracks per-player pin count



Auto-locks at timer end



Transitions



All players locked OR timer expires



→ ROUND\_2\_RESOLVE



State: ROUND\_2\_RESOLVE



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



→ ROUND\_3\_INTRO



4\. Round 3 – Final Podium

State: ROUND\_3\_INTRO



Big Screen



“Final Round – Podium”



Phones



“Stay above zero”



Server



Converts scores → starting heights



Transition



Auto



→ ROUND\_3\_QUESTION



State: ROUND\_3\_QUESTION



Big Screen



Shows question + A/B/C/D



Phones



Show A/B/C/D



Timer visible



Server



Accepts answers with timestamps



Transition



Timer expires OR all answers received



→ ROUND\_3\_RESOLVE



State: ROUND\_3\_RESOLVE



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



If >2 players remain → ROUND\_3\_QUESTION



If 2 players remain → ROUND\_3\_COUNTDOWN



If 1 player remains → GAME\_OVER



State: ROUND\_3\_COUNTDOWN



Server



Starts fixed question countdown (e.g. 5 questions)



Rules



No eliminations mid-question



Heights still change



Transition



Countdown complete



→ winner by height



If tied → ROUND\_3\_SUDDEN\_DEATH



State: ROUND\_3\_SUDDEN\_DEATH



Big Screen



One final question



Phones



A/B/C/D



Rule



First correct answer wins



Transition



→ GAME\_OVER



5\. Game Over

State: GAME\_OVER



Big Screen



Winner screen



“Play again?”



Phones



Winner / spectator screens



Transition



Host selects:



Play again → LOBBY\_WAITING



End session → IDLE



Failure \& Edge Handling

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

