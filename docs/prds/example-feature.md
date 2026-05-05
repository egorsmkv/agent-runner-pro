# PRD: RSS News Reader

## Summary

Build a small Python app with a React UI that renders news items from any
public RSS feed URL. The app should let a developer run one command locally,
enter or select an RSS feed, fetch the feed through a Python backend, and browse
normalized article cards in the browser.

## Requirements

- [ ] US-001: Create a Python HTTP API that accepts an RSS feed URL and returns
  normalized JSON news items.
- [ ] US-002: Validate feed URLs before fetching and return clear client errors
  for missing, invalid, unreachable, or non-RSS feeds.
- [ ] US-003: Parse common RSS and Atom fields into a stable item shape:
  `title`, `link`, `description`, `publishedAt`, and `source`.
- [ ] US-004: Build a React UI with a feed URL input, a few example feed
  shortcuts, loading and error states, and a refresh action.
- [ ] US-005: Render fetched articles as scannable cards with title, source,
  date, description, and a link to open the original article.
- [ ] US-006: Add focused tests for URL validation, feed parsing, API error
  behavior, and the main React UI states.
- [ ] US-007: Update README usage instructions with setup, local development,
  test, and example feed commands.

## Suggested Implementation

- Use a Python backend endpoint such as `GET /api/feed?url=<encoded-feed-url>`.
- Use `uv` for Python environment setup, including initializing a local `.venv`
  before installing backend dependencies.
- Keep RSS fetching and parsing logic isolated from the HTTP route handler.
- Serve the React app from the same local development workflow when practical.
- Prefer a maintained Python RSS parsing package over hand-rolled XML parsing.
- Keep the UI useful on desktop and mobile without requiring authentication or
  persistence.

## Quality Gates

- uv run pytest
- yarn build

## Example Feeds

- https://feeds.bbci.co.uk/news/world/rss.xml
- https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml
- https://www.theverge.com/rss/index.xml

## Acceptance Notes

- A developer can initialize the Python virtual environment with `uv`, start the
  app locally, and load at least one example feed.
- Invalid input does not crash the app or server.
- Feed fetch failures are visible in the UI.
- The API response does not expose raw parser internals.
- The implementation does not require a database.

## Out of Scope

- User accounts, saved preferences, or authentication.
- Full-text article scraping.
- Push notifications or background polling.
- Deploying the app to production infrastructure.
- Paid news APIs.
