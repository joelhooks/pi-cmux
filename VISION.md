# pi-cmux Vision

## Intent

`pi-cmux` is the cmux integration extension for Pi.

Its job is to make Pi agent sessions visible and steerable inside local cmux terminal surfaces and cmux SSH relays, while cleanly no-oping in ordinary shells. The extension should support orchestrator sessions with control tools and worker sessions with visibility-only behavior.

## Who It Serves

- Operators running Pi in cmux who need live session status, attention, and notifications.
- Orchestrator sessions coordinating worker agents across cmux workspaces.
- Worker agents that should report progress without spawning recursive helper sessions.

## Product Bet

Terminal orchestration works better when each agent remains a real visible Pi session. cmux supplies the terminal fabric, Pi supplies the agent runtime, and this extension supplies the narrow bridge between them.

## Priorities

1. **Reliable cmux detection.** Activate only inside supported cmux local or SSH relay contexts.
2. **Useful visibility.** Keep sidebar state, tool activity, model/usage metadata, and notifications accurate.
3. **Worker safety.** Preserve worker mode and fork-bomb prevention as hard constraints.
4. **Remote relay grace.** Degrade clearly when a remote cmux wrapper lacks a local command.
5. **Orchestration path.** Grow spawn/read/send/kill and fleet features only when they preserve real Pi session visibility.

## Non-Goals

- Do not replace cmux as the terminal workspace manager.
- Do not hide worker agents behind headless automation when visible Pi sessions are needed.
- Do not spawn recursive helper sessions in worker mode.
- Do not pretend unsupported remote relay commands succeeded.

## Merge By Default

Merge small, tested changes that:

- improve cmux local or SSH relay detection;
- make sidebar/progress state more accurate;
- harden worker-mode and child-process guards;
- clarify command errors for unsupported cmux modes;
- add focused tests around status, notification, and lifecycle behavior.

## Needs Owner Sign-Off

Stop for explicit approval before:

- changing worker-mode safety semantics;
- increasing default agent concurrency;
- making hidden headless worker pools the default path;
- changing notification or attention behavior in a noisy way;
- broadening the extension into a full orchestration framework without a proven slice.

## Evidence Of Progress

The extension is working when:

- local cmux Pi sessions show accurate sidebar status;
- cmux SSH relay sessions degrade gracefully when commands are missing;
- worker agents keep visibility but do not spawn helpers;
- notifications and unread attention clear at the right time;
- orchestration additions keep agents visible and recoverable.
