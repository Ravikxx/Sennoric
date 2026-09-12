# Sennoric TODO — next features

- **GitHub repo integration (Sennoric Electron app)** — let Sennoric select and operate directly inside a local
  or GitHub-hosted repository from the desktop app.
  - Explore the integration split: use the local Git CLI for working-tree operations and the GitHub API
    for remote-only features such as repository discovery, pull requests, issues, and authentication.
  - Define Electron workspace permissions before expanding access: selected repo root as the default file
    boundary, explicit grants for additional folders, safe handling of symlinks and `..` paths, and clear
    read/write/command permission states.
  - Design repo UI: open an existing local repo, clone a GitHub repo, show the active repo/branch/status,
    connect or disconnect GitHub, and explain the current workspace scope.
  - Build in stages: harden local repo selection and scoped file access first; add GitHub authentication,
    repo discovery/cloning, and remote API actions after the security boundary is tested.

- **"Slow mode" for chat** — a user-facing toggle that routes a request to the old Hugging Face Space
  (CPU inference, same Fresco 1.2.5 weights, just ~220s instead of ~2-3s) instead of the RunPod GPU backend.
  Deferred: at current traffic, RunPod's GPU-second cost is already tiny, so the savings from offloading to
  HF probably don't justify reviving and permanently maintaining a second inference backend (the Gradio
  submit/poll/SSE adapter that was deliberately removed from `fresco-upstream.js` this session). Worth
  revisiting if traffic grows enough for RunPod cost to matter, or if RunPod reliability becomes a recurring
  problem and this doubles as a fallback. The user has a more ambitious idea building on this — ask before
  starting, don't assume the scope above is the final shape.

- **Own STT and maybe TTS model** — train an in-house speech-to-text model, and possibly text-to-speech
  too. Not relevant right now (noted mid-Fresco-1.3 work) — no scope/plan yet, just a future idea to revisit.

- **RAG (Retrieval-Augmented Generation)** — explore adding retrieval-augmented generation. Not relevant
  right now — no scope/plan yet, just a future idea to revisit.

- **Wifi-network safety-monitoring model** — explore training a model that watches your wifi network and
  verifies it's safe. Not relevant right now — no scope/plan yet, just a future idea to revisit.

- **Text-to-3D model** — explore a text-to-3D generation model. Not relevant right now — no scope/plan yet,
  just a future idea to revisit.
