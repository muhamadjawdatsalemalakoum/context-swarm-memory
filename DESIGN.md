---
version: alpha
name: CSM
description: Context Swarm Memory — a calm, credible visual system for an AI memory layer that gets sharper as data grows.

colors:
  primary: "#0E7C66"
  primary-soft: "#DDF7EF"
  primary-deep: "#064E3B"

  secondary: "#2563EB"
  secondary-soft: "#EAF1FF"

  accent: "#F59E0B"
  accent-soft: "#FFF4D8"

  neutral: "#FAFBF8"
  surface: "#FFFFFF"
  surface-soft: "#F8FAFC"
  surface-raised: "#FFFFFF"

  text: "#111827"
  text-muted: "#475569"
  text-soft: "#64748B"

  border: "#D8DEE6"
  border-soft: "#E5E7EB"

  success: "#22C55E"
  warning: "#F97316"
  danger: "#DC2626"

  on-primary: "#FFFFFF"
  on-surface: "#111827"

typography:
  display:
    fontFamily: Inter
    fontSize: 64px
    fontWeight: 800
    lineHeight: 1
    letterSpacing: -0.045em

  headline-lg:
    fontFamily: Inter
    fontSize: 40px
    fontWeight: 750
    lineHeight: 1.1
    letterSpacing: -0.035em

  headline-md:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.025em

  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: -0.01em

  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: -0.005em

  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5

  label-md:
    fontFamily: Geist Mono
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.02em

  label-sm:
    fontFamily: Geist Mono
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: 0.04em

spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  hero-x: 72px
  hero-y: 64px
  section-gap: 40px

rounded:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 20px
  xl: 28px
  full: 9999px

components:
  badge:
    backgroundColor: "{surface}"
    textColor: "{text-muted}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 8px
    height: 32px

  badge-primary:
    backgroundColor: "{primary-soft}"
    textColor: "{primary-deep}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 8px
    height: 32px

  badge-secondary:
    backgroundColor: "{secondary-soft}"
    textColor: "{secondary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 8px
    height: 32px

  badge-accent:
    backgroundColor: "{accent-soft}"
    textColor: "{warning}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 8px
    height: 32px

  card:
    backgroundColor: "{surface}"
    textColor: "{text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 24px

  memory-packet:
    backgroundColor: "{surface}"
    textColor: "{text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 20px

  source-chip:
    backgroundColor: "{surface-soft}"
    textColor: "{text-muted}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 36px

  button-primary:
    backgroundColor: "{primary}"
    textColor: "{on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 44px

  button-secondary:
    backgroundColor: "{surface}"
    textColor: "{text}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 44px

  diagram-node:
    backgroundColor: "{surface}"
    textColor: "{text-muted}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.md}"
    padding: 12px
---

# CSM Design System

## Overview

CSM — Context Swarm Memory — should feel like trustworthy infrastructure for future AI agents.

The visual identity must communicate one central idea:

**Memory gets sharper as it scales.**

CSM is not a generic AI chatbot brand. It is a memory layer for long-running agents that remember projects, people, decisions, sources, and context over time. As data grows, the system should feel more organized, more grounded, and more useful — not heavier or more chaotic.

The brand should feel:

- calm
- precise
- grounded
- technical
- future-facing
- open-source credible
- quietly intelligent
- durable
- transparent
- elegant

The emotional target is:

> “This feels like infrastructure I can trust with long-running AI memory.”

The product should never feel like vague AI magic. It should feel engineered, verifiable, and safe.

## Colors

The CSM palette is mostly white/off-white with restrained technical accents.

Use **warm off-white** as the default background. Avoid pure sterile white when a softer technical surface is possible.

- **Primary Teal (`#0E7C66`)**
  The main CSM color. Use it for memory paths, active states, shard highlights, and the most important brand accents. It represents grounded intelligence and durable memory.

- **Secondary Blue (`#2563EB`)**
  Use sparingly for routing, selected paths, links, and technical comparison states. Blue should support teal, not dominate it.

- **Amber Accent (`#F59E0B`)**
  Use only for commit-only writes, warnings, special evidence markers, or important secondary emphasis. Amber should feel precise, not decorative.

- **Slate Text (`#111827`, `#475569`, `#64748B`)**
  Use slate and near-black text for credibility. Avoid washed-out gray for important claims.

- **Soft Borders (`#D8DEE6`, `#E5E7EB`)**
  Borders should be visible but gentle. CSM components should feel like carefully organized memory surfaces, not heavy boxes.

Do not use:

- excessive rainbow gradients
- dark cyberpunk backgrounds
- neon purple/blue glow
- glossy SaaS gradients
- fake sci-fi dashboard colors
- oversaturated candy colors

## Typography

Typography should be modern, technical, and calm.

Preferred fonts:

- **Inter** for primary UI, headings, body copy, and README graphics.
- **Geist Mono** or **JetBrains Mono** for badges, source chips, event IDs, snapshot IDs, and technical labels.
- **IBM Plex Sans** is an acceptable alternative when a slightly more research-oriented tone is desired.
- **Space Grotesk** may be used only for large “CSM” display text if it remains clean and legible.

Rules:

- Use large, confident typography for `CSM`.
- Use smaller, calm typography for `Context Swarm Memory`.
- Use one short tagline only.
- Keep technical labels small but readable.
- Avoid overly futuristic display fonts.
- Avoid decorative AI-style typefaces.
- Avoid condensed cyberpunk fonts.

Recommended cover hierarchy:

```text
CSM
Context Swarm Memory
Memory that gets sharper as it scales
```
