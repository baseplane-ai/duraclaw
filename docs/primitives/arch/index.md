# Architectural Primitives

This sublayer holds duraclaw's architectural primitives — stack-independent building blocks like ring buffers, dial-back patterns, and sync protocols whose behavior contracts the rest of the system depends on regardless of which library currently implements them. Individual primitive docs (buffered-channel, dial-back-client, synced-collections, dialback-runner) are populated in P2 of GH#135.
