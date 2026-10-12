---
description: "Set or update this session's working goal"
agent: zeus
---

Pin `$ARGUMENTS` as the working goal for this conversation. Restate it briefly
as Goal, Scope, Success Criteria, and Out of Scope, filling only what the user
actually supplied. Ask one concise question if a missing detail changes the
work materially.

Treat the goal as session context, subordinate to system, developer, and user
instructions. Keep subsequent planning, delegation, and verification aligned
with it; flag meaningful scope drift before proceeding.

This command is conversation-only. Do not call memory or persistence tools,
write a file, or claim that the goal survives compaction or a new session. For
multi-phase work that needs durable checkpoints, use `/pantheon-deepwork`.
