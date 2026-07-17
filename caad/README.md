# CAAD — Canonical Artifacts & Architecture Database

## Purpose

CAAD is the structured registry for Lantern OS artifacts, doors, symbols, product backlog, generated art direction, and public-safe memory.

It organizes symbolic and product material without turning symbol into proof, prophecy, diagnosis, authority, or command.

## Restore Phrase

> This is symbolic material. It is not proof, prediction, or command.

## Structure

```
caad/
  README.md              — This file
  schema/                — JSON schemas for artifact validation
    door.schema.json
    artifact.schema.json
    symbol.schema.json
    backlog.schema.json
  registry/              — Append-only JSONL registries
    doors.jsonl
    symbols.jsonl
    artifacts.jsonl
    backlog.jsonl
  product/               — Product-specific CAAD entries
    dream-journal/
  architecture/          — System architecture docs
    caad-oss.md
  validation/            — CI validation scripts
    caad-validate.py
```

## Safety Boundary

Public CAAD may include:
- Symbolic summaries
- Prompts
- Generated image metadata
- Schemas
- Public-safe backlog
- Non-private art direction

Public CAAD must not include:
- Private journals
- Private people's unreviewed details
- Raw chat logs
- Unreviewed hold archives
- Claims of prophecy, diagnosis, divine command, surveillance, or deployment authority

## Promotion Gate

A symbol can leave CAAD only when it passes all checks:
- No private-person exposure
- No pressure on a real person
- No hidden surveillance or telemetry
- No diagnosis, cure, prophecy, or emergency advice
- No claim that imagination is current capability
- No runtime, merge, deployment, or agent authority
- One reversible next action exists
- A human operator explicitly chooses the destination
