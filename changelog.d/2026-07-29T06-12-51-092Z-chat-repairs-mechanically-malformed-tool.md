### Changed

- Chat repairs mechanically-malformed tool calls (JSON-string args, wrong key casing, stringified numbers) instead of wasting a step rejecting them
