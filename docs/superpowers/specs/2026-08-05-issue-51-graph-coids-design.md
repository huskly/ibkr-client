# Issue 51 Design

## Goal

Make each derivative order graph ticket usable as both a child and a parent. Keep the broker rejection detail from a failed synchronous response.

## Ticket identity

The client sends a deterministic `cOID` for every graph node. A non-root node also sends its exact parent's deterministic ID as `parentId`. This supports graph depth one through eight without a second placement attempt.

## Rejection evidence

The client treats a failed synchronous response with a meaningful `text` or `warning_message` field as rejection evidence. It keeps the full raw record in `BrokerErrorDetail.details`. A recovery result includes the readable rejection text before generic status or count messages. The client still retains all partial broker evidence and never retries a placement.

## Tests and documentation

Tests use the real graph submission path with a fake transport. They verify the full three-level ticket links and the paper-response rejection shape. The README explains that all graph members send a `cOID` and that synchronous rejection text remains available to callers.
