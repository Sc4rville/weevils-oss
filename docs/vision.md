# Vision — overrides the kit

Spoken clarifications from November 8, 2026. If anything here conflicts with `harness-interface-kit/` (the original
French design brief), this file wins.

## Look

- **Everything is a band**: full-width horizontal strips stacked on top of each other. Each band has its own color.
- **No spot without color**: no separators, no neutral background, no gutters. Even the system areas (top and
  bottom of the phone) are colored.
- **No boxes, no cards, no drawn icons.** Everything happens inside the bands.
- **Icons are keyboard characters** (`+`, `!`, `/`, `>`, `*`, `#`, `@`, `↑`…), sometimes larger, to say things
  instead of pictograms.
- **One typeface**: the one of Notes on iPhone (Apple's system font). Only weight and size vary, never a second family.
- **Light**: really bright colors, black text. **Dark**: deep but welcoming colors, white text.
- Pop, simple.

## Interaction

- **Dynamic, physical**: touching a band opens it and the others fold; one thing moves another (spring animations,
  motion with inertia).
- **Adaptive size, never "behind"**: the open band grows (big title, all its content), the others become thin
  strips (name + summary). No band slides under another, no text is cut by the next band. References we liked:
  straight full-width bands (AI OS, Slava Kornilov) and the varying thickness (a cycling app) — not their stacked
  cards nor their rounded corners.
- **At the top**: the main agent, the central place to monitor and prompt everything.
- **At the bottom**: a sticky band with the agents that run 24/7 and what is around them.
- **Every conversation/session opens as a chat** and you interact with it directly (like a cloud console where you
  click a resource to drive it).

## What the system does (backend target)

- Organized **by repo**.
- A smart layer that sees what happens on the server, on GitHub, and knows the ChatGPT and Claude transcripts.
- It sorts this stream into the bands automatically; when an item belongs to no repo, it **invents a category**.
- It can **remotely control** the sessions running on the server.

## Platform

- Main use: **the phone (iPhone)**.
