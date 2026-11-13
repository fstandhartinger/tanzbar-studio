# tanzbar-studio

Private voice studio for [diskret-tanzbar.de](https://diskret-tanzbar.de): Michi (Michael Mirage) talks to a voice agent
(xAI Grok Voice) about changes to his website; after he confirms, a Claude Code job implements and publishes them.

```
diskret-tanzbar.de/#studio=<token>  (front end: assets/studio/ in the diskret-tanzbar repo)
   │  GET /api/state, WSS /api/voice  (PCM16 24 kHz both ways)
   ▼
tanzbar-studio gateway (this repo, Coolify app https://tanzbar-studio.app.mintapis.com)
   │  Grok Voice realtime (tools: seite_lesen, verstaendnis_zeigen, auftrag_starten, status_abfragen)
   │  POST /api/runner/sync  (runner polls every 4 s; the runner owns job state)
   ▼
runner/tanzbar-studio-runner.py on Sandy (systemd user unit)
   → ~/jobs/tanzbar-studio-change-<id>/ + run-claude.sh (JOB_HOST=lechonk, Opus)
   → git push from Sandy → Render auto-deploy → progress back to the page
```

Env (gateway): `STUDIO_TOKEN_SHA256` (sha256 hex of the link token), `RUNNER_SECRET`, `XAI_API_KEY`,
optional `ALLOWED_ORIGINS`, `MAX_JOBS_PER_DAY` (10), `MAX_OPEN_JOBS` (3), `MAX_SESSIONS_PER_DAY` (40), `MAX_SESSION_MS` (15 min).
No state is persisted in the gateway; secrets only come from env. The token never appears in this repo.

Runner: `runner/tanzbar-studio-runner.py` + `runner/PROMPT-TEMPLATE.md`, env file `~/.config/tanzbar-studio/runner.env`
(`RUNNER_SECRET`, `STUDIO_API`), state `~/.local/state/tanzbar-studio/jobs.json`.

Rotate the link: new token → update `STUDIO_TOKEN_SHA256` in Coolify → redeploy → send the new link.
