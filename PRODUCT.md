# Product

## Register

product

## Users

Internal operator running multi-account automation against the livestream reward platforms (78win / MB66 / QQ88). Context: single-user desktop tool (Electron), runs long-lived background jobs (tracker, farm batches, livestream pushes). Job to be done: queue work, watch status, intervene on errors.

## Product Purpose

Drive repetitive account operations (login, session keep-alive, attendance, lì xì claims, share farming, RTMP push) from one console. Success = fewer manual steps per batch, clear per-account state, no silent failures.

## Brand Personality

3 words: dense, operational, terse. This is a control surface, not a marketing page — tone is utilitarian Vietnamese, short labels, status-forward.

## Anti-references

- SaaS marketing dashboards (hero metrics, gradient text, decorative cards).
- "Friendly" consumer apps — no illustrations, no onboarding copy, no celebration states.
- Cream/beige light themes; this tool runs dark.

## Design Principles

- Status over decoration: every element either shows live state or triggers an action.
- One control = one job: no ambiguous multi-purpose inputs.
- Errors surface inline where they happen, not in a distant toast only.
- Dense but readable: compact spacing, never cramped text.
- Dark theme is the default; light is not supported.

## Accessibility & Inclusion

WCAG AA baseline: body text ≥4.5:1 contrast, visible focus rings, no meaning carried by color alone (always paired with text/icon), `prefers-reduced-motion` respected.
