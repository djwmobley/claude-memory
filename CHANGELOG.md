# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-18

### Added

- Initial public release of the claude-memory handoff and retrieval
  infrastructure.
- Claude Code plugin packaging: the project is installable as a Claude Code
  plugin (manifest, marketplace metadata, hook wiring, and plugin-root asset
  resolution). The loader hook stays inert when no project marker is present
  and never silently falls back to SQLite.

### Changed

- Project identity is now resolved from a durable marker-borne UUID instead of
  a path-derived identifier, with re-entrant and concurrent migration guards
  and idempotent legacy reconciliation.
- Remaining raw-SQL paths moved behind storage-port methods so the
  Postgres/SQLite storage seam translates correctly, backed by adversarial
  both-backend test coverage.

### Fixed

- A same-session exact-repeat reinforcement now takes a touch-only path that
  does not reset the decay clock, correcting a supersession/decay edge case.
