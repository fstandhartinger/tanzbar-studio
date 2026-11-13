# tanzbar-studio

Private studio for [diskret-tanzbar.de](https://diskret-tanzbar.de): Michi (Michael Mirage) talks to an agent about
changes to his website — live by voice (xAI Grok Voice) or WhatsApp-style by text and voice messages — adds material
(photos, files, texts, links), gets previews, sketches and his version history, and after he confirms, a Claude Code job
implements and publishes the change. Any version since the studio exists can be restored.

```
diskret-tanzbar.de/#studio=<token>   front end: assets/studio/ in the diskret-tanzbar repo (black-hole entrance, eye, feed, composer)
   │  WSS /api/ui (feed, jobs, material)   WSS /api/voice (PCM16 24 kHz)   POST /api/chat, /api/chat/voice, /api/material
   ▼
gateway (this repo, Coolify app tanzbar-studio on Sandy, https://tanzbar-studio.app.mintapis.com)
   │  live: Grok Voice realtime · chat: grok-4.7 with the same tools · voice messages: Groq Whisper (OpenAI fallback)
   │  tools: seite_lesen, verstaendnis_zeigen, auftrag_starten, status_abfragen, vorschau_erstellen, skizze_zeigen,
   │         versionen_zeigen, version_wiederherstellen, material_auflisten
   │  POST /api/runner/sync every 4 s (the runner owns jobs, versions and the persisted feed)
   ▼
runner/tanzbar-studio-runner.py on Sandy (systemd user unit tanzbar-studio-runner)
   → change: ~/jobs/tanzbar-studio-change-<id>/ (repo clone + attachments + PROMPT.md) → run-claude.sh opus, JOB_HOST=lechonk
   → restore: checkout of an older tree (studio files kept), no agent
   → git push from Sandy → Render auto-deploy → progress + result back to the page
   → previews: grok-4.7 writes a DOM patch, LeChonk renders before/after (runner/preview/ → ~/tanzbar-studio-preview)
```

Gateway env (write-only in Coolify, set by `runner/set_env.py` on Sandy, values never leave Sandy):
`STUDIO_TOKEN_SHA256`, `RUNNER_SECRET`, `XAI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`; optional limits
`MAX_JOBS_PER_DAY` (12), `MAX_OPEN_JOBS` (3), `MAX_SESSIONS_PER_DAY` (40), `MAX_CHAT_PER_DAY` (300), `MAX_PREVIEWS_PER_DAY` (40).
The gateway keeps material, previews and voice-message audio in memory only (lost on restart; jobs keep their own copies).

Runner files on Sandy: `~/tanzbar-studio-runner/` (runner, PROMPT-TEMPLATE.md, set_env.py, reset-feed.py),
env `~/.config/tanzbar-studio/runner.env`, the link in `~/.config/tanzbar-studio/link.txt` (600), state
`~/.local/state/tanzbar-studio/jobs.json`.

Operations:
- Clear the conversation and show the first-visit intro again: `python3 ~/tanzbar-studio-runner/reset-feed.py` (Sandy).
- Rotate the link: delete `link.txt`, run `set_env.py STUDIO_TOKEN_SHA256` (it creates a new token), redeploy the app,
  send the new link.
- Restore points start at commit 5e54b4a (first version with the studio); older trees would lock the studio out.
