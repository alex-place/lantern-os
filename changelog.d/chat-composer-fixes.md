### Changed
- **Chat composer cleanup.** The `+` button now opens the default file picker directly instead of a multi-option popup menu (the PDF→Knowledge-Center / Improve-doc / Document-Studio / "soon" entries are gone). The dead menu markup and CSS were removed.

### Fixed
- **Mic button gives visible feedback.** The 🎙️ voice-input button had no style for its listening state, so clicking it engaged the mic silently and felt broken. It now turns red and pulses while recording.
- **Agent replies no longer spread into dead clickable columns.** `.message` is a flex row, so the route signature and "Read aloud" button (appended as siblings of the bubble) were laid out in wide empty columns beside the reply. Agent messages now stack vertically (bubble → signature → read-aloud), left-aligned.
