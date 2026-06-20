# Contributing to Lantern OS

Thank you for your interest in contributing to Lantern OS! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

We are committed to providing a welcoming and inclusive environment for all contributors. 

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally
3. **Create a feature branch**: `git checkout -b feature/your-feature-name`
4. **Read QUICKSTART.md** to set up the development environment

## Development Workflow

### Per-Agent Workstream (Monoworkstream Rule)

Each agent gets **one open PR lane at a time**.

## Code Style

- **JavaScript**: Use ES6+
- **Indentation**: 2 spaces
- **Comments**: Document WHY, not WHAT
- **Naming**: camelCase for variables, PascalCase for classes

## Accessibility (WCAG 2.1 AA)

Before submitting a PR:

- Test keyboard-only navigation (Tab, Enter, Escape)
- Check color contrast (WebAIM Contrast Checker)
- Add ARIA labels to interactive elements
- Test with a screen reader
- Ensure focus indicators are visible (3px outline)
- Support prefers-reduced-motion

## Internationalization (I18n)

When adding UI text:

1. Add to locale files (apps/lantern-garage/public/locales/*.json)
2. Current languages: English, Spanish, German, Japanese

## Testing

Run: `python -m pytest tests/ -q --tb=short`

## Documentation

- Update QUICKSTART.md for new features
- Update docs/convergence-core-mapping.md for architecture changes
- Use Markdown with code examples

## PR Process

1. Branch up-to-date: `git rebase origin/master`
2. All tests pass
3. Create PR with clear title
4. Link related issues
5. Request review
6. Address feedback
7. Maintainers merge when approved

## Questions?

- General questions: Open a GitHub Discussion
- Security issues: See SECURITY.md
- Contact: open a GitHub issue

---

**Happy contributing!** 🎉
