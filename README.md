# NotebookLM SRS Extension

Chrome MV3 extension that adds spaced repetition reminders on top of NotebookLM activity completion.

## Features

- Auto-detect completion signals for NotebookLM quiz/flashcards/podcast activities.
- Maintain timelines per activity content item.
- Default intervals: `1, 7, 14, 30` days.
- Editable interval settings in injected in-page panel.
- Chrome notifications for due reminders.
- Local-only storage (`chrome.storage.local`).

## Development

```bash
bun install
bun run build
```

Load extension from `dist/` in Chrome (`chrome://extensions` -> Developer mode -> Load unpacked).

Useful commands:

```bash
bun run build:watch
bun run check
bun run test:e2e
```

## E2E test notes

- E2E tests live in `tests/e2e` and use Playwright with a real MV3 extension load.
- The suite stubs `https://notebooklm.google.com/*` responses to validate extension behavior deterministically.
- On Linux, tests require a display server (`DISPLAY`) because Chromium extension tests run headed mode.
