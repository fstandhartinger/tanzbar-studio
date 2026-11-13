#!/usr/bin/env python3
"""tanzbar-studio-runner (Sandy): the worker behind Michi's studio on diskret-tanzbar.de.

Every POLL s: POST <API>/api/runner/sync {jobs, versions, profile} -> {claim (new requests), previews, profile}.
- change jobs: ~/jobs/tanzbar-studio-change-<id>/ (repo clone + material + PROMPT.md) -> run-claude.sh (JOB_HOST=lechonk, Opus)
  -> git push from Sandy (only Sandy has GitHub credentials) -> Render auto-deploy -> live | failed
- restore jobs: back to an earlier version without an agent (git checkout of that tree, studio files kept) -> push -> deploy
- previews: grok writes a small DOM patch + area selector, LeChonk renders before/after (~/tanzbar-studio-preview), images go back
- versions: commits on main since the studio exists (studio-only commits hidden), labelled in German where known
- profile: the gateway's conversation feed + intro flag, persisted here because the gateway keeps nothing on disk
One job runs at a time; previews run in parallel threads. State: ~/.local/state/tanzbar-studio/jobs.json.
Env (runner.env): RUNNER_SECRET, STUDIO_API. RENDER_API_KEY and XAI_API_KEY come from ~/.config/dev-secrets.env.
"""
import base64
import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

HOME = os.path.expanduser('~')
HERE = os.path.dirname(os.path.abspath(__file__))
API = os.environ.get('STUDIO_API', 'https://tanzbar-studio.app.mintapis.com').rstrip('/')
SECRET = os.environ.get('RUNNER_SECRET', '')
STATE_DIR = os.path.join(HOME, '.local/state/tanzbar-studio')
STATE = os.path.join(STATE_DIR, 'jobs.json')
JOBS_ROOT = os.path.join(HOME, 'jobs')
MIRROR = os.path.join(HERE, 'mirror')
REPO_URL = 'https://github.com/fstandhartinger/diskret-tanzbar'
RENDER_SERVICE = 'srv-d654b4e3li6c73995tbg'
SITE = 'https://diskret-tanzbar.de'
STUDIO_BASE = '5e54b4a'  # first commit with the studio; older versions cannot be restored (they would lock the studio out)
LOADER = ("\n  // Studio loader: the private voice studio opens only through the secret link (#studio=...). Keep this block.\n"
          "  if (/^#studio=[\\w-]{20,}$/.test(location.hash)) import('/assets/studio/studio.js').catch(() => {});\n")
POLL = 4
RUN_TIMEOUT = 100 * 60
DEPLOY_TIMEOUT = 20 * 60
ACTIVE = ('starting', 'running', 'publishing', 'deploying')
LOCK = threading.Lock()
POOL = cf.ThreadPoolExecutor(max_workers=2)
INFLIGHT = set()


def now():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def log(*a):
    print(now(), *a, flush=True)


def load():
    try:
        with open(STATE) as f:
            st = json.load(f)
    except Exception:
        st = {}
    st.setdefault('jobs', {}); st.setdefault('labels', {}); st.setdefault('profile', None); st.setdefault('versions', [])
    st.setdefault('versionsAt', 0)
    return st


def save(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE + '.tmp'
    with LOCK:
        with open(tmp, 'w') as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
        os.replace(tmp, STATE)


def sh(cmd, cwd=None, timeout=300, inp=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, input=inp)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def secret(name):
    try:
        with open(os.path.join(HOME, '.config/dev-secrets.env')) as f:
            for line in f:
                m = re.match(rf'^export {name}=(.*)$', line.strip())
                if m:
                    return m.group(1).strip().strip('"').strip("'")
    except Exception:
        pass
    return ''


def http(method, url, body=None, headers=None, timeout=30, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'content-type': 'application/json', 'user-agent': 'tanzbar-studio-runner', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        b = r.read()
        return b if raw else json.loads(b.decode() or '{}')


AUTH = lambda: {'Authorization': f'Bearer {SECRET}'}


def progress(job, text):
    text = str(text).strip()[:160]
    if text and not (job['progress'] and job['progress'][-1]['text'] == text):
        job['progress'].append({'t': now(), 'text': text})
        job['progress'] = job['progress'][-60:]
    job['updatedAt'] = now()


def set_status(job, status, text=None):
    job['status'] = status
    job['updatedAt'] = now()
    if text:
        progress(job, text)


def public(job, position=None):
    out = {k: job.get(k) for k in ('id', 'type', 'createdAt', 'updatedAt', 'title', 'points', 'status', 'progress', 'summary', 'error')}
    out['position'] = position
    return out


def notify(text):
    try:
        sh([os.path.join(HOME, 'bin/notify'), 'digest', 'tanzbar-studio', text], timeout=60)
    except Exception as e:
        log('notify failed', e)


def fail(job, msg_for_michi, detail=''):
    job['error'] = msg_for_michi
    set_status(job, 'failed', 'Abgebrochen')
    log('FAILED', job['id'], msg_for_michi, str(detail)[-600:])
    notify(f"Michis Studio-Auftrag \"{job['title']}\" ist fehlgeschlagen: {msg_for_michi} Job: {job.get('dir', '-')}")


# ---------------------------------------------------------------- versions
def refresh_versions(st, force=False):
    if not force and time.time() - st.get('versionsAt', 0) < 60:
        return
    st['versionsAt'] = time.time()
    if not os.path.isdir(os.path.join(MIRROR, '.git')):
        rc, out = sh(['git', 'clone', '--quiet', REPO_URL, MIRROR], timeout=180)
        if rc:
            return log('mirror clone failed', out[-300:])
    rc, out = sh(['git', '-C', MIRROR, 'fetch', '--quiet', 'origin'], timeout=120)
    if rc:
        return log('mirror fetch failed', out[-300:])
    rc, out = sh(['git', '-C', MIRROR, 'log', '--format=@@%H\t%cI\t%s', '--name-only', f'{STUDIO_BASE}^..origin/main'], timeout=60)
    if rc:
        return
    versions = []
    for block in out.split('@@')[1:]:
        head, *files = [l for l in block.strip().splitlines() if l.strip()]
        sha, date, subject = (head.split('\t') + ['', ''])[:3]
        if files and all(re.match(r'^(assets/studio/|README\.md$)', f) for f in files):
            continue  # studio-only commits are not site versions
        versions.append({'sha': sha, 'date': date, 'subject': subject[:120], 'label': st['labels'].get(sha) or st['labels'].get(sha[:7]) or ''})
    st['versions'] = versions[:15]


# ---------------------------------------------------------------- change + restore jobs
def write_prompt(job, jd):
    with open(os.path.join(HERE, 'PROMPT-TEMPLATE.md')) as f:
        tpl = f.read()
    transcript = '\n'.join(f"- **{'Michi' if t.get('role') == 'michi' else 'Studio'}:** {t.get('text', '')}" for t in job.get('transcript', [])[-40:])
    points = '\n'.join(f'- {p}' for p in job.get('points', []))
    att = []
    for a in job.get('attachments', []):
        if a.get('path'):
            att.append(f"- `{a['path']}` ({a['kind']}, {a.get('mime', '')}){': ' + a['description'] if a.get('description') else ''}")
        elif a['kind'] == 'url':
            att.append(f"- Link: {a.get('url')}")
        elif a['kind'] == 'text':
            att.append(f"- Text (also in `attachments/{a['id']}-text.txt`): \"{a.get('text', '')[:1500]}\"")
    body = (tpl.replace('{{ID}}', job['id']).replace('{{TITLE}}', job['title']).replace('{{POINTS}}', points or '-')
            .replace('{{SPEC}}', job.get('spec', '')).replace('{{CONFIRMATION}}', job.get('confirmation', ''))
            .replace('{{TRANSCRIPT}}', transcript or '-').replace('{{JOBDIR}}', jd)
            .replace('{{ATTACHMENTS}}', '\n'.join(att) if att else 'None.'))
    with open(os.path.join(jd, 'PROMPT.md'), 'w') as f:
        f.write(body)
    with open(os.path.join(jd, 'REQUEST.json'), 'w') as f:
        json.dump({k: job.get(k) for k in ('id', 'createdAt', 'title', 'points', 'spec', 'confirmation', 'transcript', 'attachments')}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(jd, 'STATE.md'), 'w') as f:
        f.write(f"# {job['title']}\n\nChange request {job['id']} from Michi via the tanzbar-studio page.\n"
                f"Started by ~/tanzbar-studio-runner (systemd user unit tanzbar-studio-runner). The runner pushes and deploys after the job.\n")
    open(os.path.join(jd, 'PROGRESS.md'), 'a').close()


def fetch_attachments(job, jd):
    os.makedirs(os.path.join(jd, 'attachments'), exist_ok=True)
    for a in job.get('attachments', []):
        try:
            if a['kind'] in ('image', 'file'):
                name = re.sub(r'[^\w.\-]', '_', a.get('name') or 'datei')[:80]
                rel = f"attachments/{a['id']}-{name}"
                with open(os.path.join(jd, rel), 'wb') as f:
                    f.write(http('GET', f"{API}/api/runner/material/{a['id']}", headers=AUTH(), timeout=120, raw=True))
                a['path'] = rel
            elif a['kind'] == 'text':
                with open(os.path.join(jd, f"attachments/{a['id']}-text.txt"), 'w') as f:
                    f.write(a.get('text', ''))
        except Exception as e:
            log('attachment failed', a.get('id'), e)


def clone(jd):
    rc, out = sh(['git', 'clone', '--quiet', REPO_URL, os.path.join(jd, 'repo')], timeout=180)
    repo = os.path.join(jd, 'repo')
    if not os.path.isdir(os.path.join(repo, '.git')):
        return None, out
    sh(['git', '-C', repo, 'config', 'user.name', 'fstandhartinger'])
    sh(['git', '-C', repo, 'config', 'user.email', 'fstandhartinger@users.noreply.github.com'])
    return repo, ''


def start(job, st):
    kind = job.get('type', 'change')
    name = f"tanzbar-studio-{'change' if kind == 'change' else 'restore'}-{job['id']}"
    jd = os.path.join(JOBS_ROOT, name)
    os.makedirs(jd, exist_ok=True)
    job.update(dir=jd, startedAt=time.time())
    set_status(job, 'starting', 'Server bereitet die Arbeit vor' if kind == 'change' else 'Hole die frühere Version')
    repo, err = clone(jd)
    if not repo:
        return fail(job, 'Konnte die Website-Dateien nicht laden.', err)
    if kind == 'restore':
        return do_restore(job, st, repo)
    fetch_attachments(job, jd)
    write_prompt(job, jd)
    rc, acc = sh([os.path.join(HOME, 'bin/quota-pace'), 'account', '--kind', 'judgement'], timeout=60)
    acc = (acc.strip().splitlines() or ['C'])[0].strip()
    acc = acc if acc in ('A', 'B', 'C') else 'C'
    unit = f'job-{name}'
    rc, out = sh(['systemd-run', '--user', f'--unit={unit}', '--collect', f'--working-directory={jd}',
                  '--setenv=JOB_HOST=lechonk', f'--setenv=CLAUDE_ACCOUNT={acc}', '--setenv=CLAUDE_EFFORT=high',
                  os.path.join(HOME, 'bin/run-claude.sh'), jd, 'opus'], timeout=60)
    if rc != 0:
        return fail(job, 'Der Agent konnte nicht starten.', out)
    job.update(unit=unit, account=acc, startedAt=time.time(), progressSeen=0)
    set_status(job, 'running', 'Agent gestartet')
    log('started', job['id'], unit, 'account', acc)


def do_restore(job, st, repo):
    sha = job.get('restoreSha', '')
    if not re.match(r'^[0-9a-f]{7,40}$', sha):
        return fail(job, 'Unbekannte Version.')
    rc, out = sh(['git', '-C', repo, 'merge-base', '--is-ancestor', STUDIO_BASE, sha])
    if rc != 0:
        return fail(job, 'Diese Version ist zu alt, um sie wiederherzustellen.', out)
    keep = [':(exclude)assets/studio', ':(exclude)README.md']
    rc, added = sh(['git', '-C', repo, 'diff', '--name-only', '--diff-filter=A', sha, 'HEAD', '--', '.', *keep])
    for f in [l.strip() for l in added.splitlines() if l.strip()]:
        try:
            os.remove(os.path.join(repo, f))
        except FileNotFoundError:
            pass
    rc, out = sh(['git', '-C', repo, 'checkout', sha, '--', '.', *keep])
    if rc != 0:
        return fail(job, 'Die Version ließ sich nicht wiederherstellen.', out)
    mm = os.path.join(repo, 'assets/mm.js')
    src = open(mm).read()
    if '#studio=' not in src:
        src = re.sub(r'\n\}\)\(\);\s*$', LOADER + '})();\n', src)
        open(mm, 'w').write(src)
    if '/assets/mm.js' not in open(os.path.join(repo, 'index.html')).read():
        return fail(job, 'Diese Version passt nicht zum Studio.')
    sh(['git', '-C', repo, 'add', '-A'])
    rc, out = sh(['git', '-C', repo, 'commit', '-q', '-m', f"Restore version {sha[:7]} ({job.get('restoreLabel', '')}) via studio\n\nRequested-by: Michi via tanzbar-studio ({job['id']})"])
    if rc != 0 and 'nothing to commit' in out:
        job['summary'] = 'Die Seite war schon auf diesem Stand.'
        return set_status(job, 'live', 'Nichts zu ändern')
    job['summary'] = f"Die Seite ist wieder auf dem Stand vom {fmt_date(job.get('points', [''])[0])}."
    job['labelForCommit'] = f"Zurück zu: {job.get('restoreLabel', '')}"[:100]
    publish(job, st, repo)


def fmt_date(s):
    return s.replace('Version vom ', '') if s else 'früher'


def unit_active(unit):
    rc, out = sh(['systemctl', '--user', 'is-active', unit], timeout=20)
    return out.strip() in ('active', 'activating', 'reloading')


def read_progress(job):
    try:
        with open(os.path.join(job['dir'], 'PROGRESS.md')) as f:
            lines = [l.strip() for l in f if l.strip()]
    except Exception:
        return
    for l in lines[job.get('progressSeen', 0):]:
        progress(job, re.sub(r'^[-*]\s*(\d{1,2}:\d{2}\s*)?', '', l))
    job['progressSeen'] = len(lines)


def finish_run(job, st):
    read_progress(job)
    res = {}
    try:
        with open(os.path.join(job['dir'], 'RESULT.json')) as f:
            res = json.load(f)
    except Exception:
        pass
    if not res.get('ok'):
        return fail(job, str(res.get('reason_for_michi') or 'Der Agent ist nicht fertig geworden.')[:300])
    job['summary'] = str(res.get('summary_for_michi') or '')[:600]
    job['labelForCommit'] = str(res.get('version_label') or job['title'])[:100]
    repo = os.path.join(job['dir'], 'repo')
    # On LeChonk the job has no .git (lechonk-job excludes it) and the sync back carries no deletions:
    # the runner applies deletions and commits the synced working tree here on Sandy.
    for f in res.get('deleted_files') or []:
        p = os.path.normpath(os.path.join(repo, str(f)))
        if p.startswith(repo + os.sep) and '/.git' not in p and os.path.isfile(p) and not str(f).startswith('assets/studio/'):
            os.remove(p)
    sh(['git', '-C', repo, 'checkout', '--', 'assets/studio'])  # the studio itself is never changed by a request
    rc, dirty = sh(['git', '-C', repo, 'status', '--porcelain'])
    if dirty.strip():
        msg_file = os.path.join(job['dir'], 'COMMIT_MSG.txt')
        msg = open(msg_file).read().strip() if os.path.exists(msg_file) else f"{job['title']}"
        if 'Requested-by:' not in msg:
            msg += f"\n\nRequested-by: Michi via tanzbar-studio ({job['id']})"
        with open(msg_file + '.final', 'w') as f:
            f.write(msg + '\n')
        sh(['git', '-C', repo, 'add', '-A'])
        rc, out = sh(['git', '-C', repo, 'commit', '-q', '-F', msg_file + '.final'])
        if rc != 0:
            return fail(job, 'Die Änderung ließ sich nicht speichern.', out)
        log('committed', job['id'])
    publish(job, st, repo, expect_change=not res.get('no_changes'))


def publish(job, st, repo, expect_change=True):
    rc, ahead = sh(['git', '-C', repo, 'log', '--oneline', 'origin/main..HEAD'])
    if rc != 0:
        return fail(job, 'Die Änderung ließ sich nicht prüfen.', ahead)
    if not ahead.strip():
        if expect_change:
            return fail(job, 'Die Änderung ist auf dem Server nicht angekommen.')
        return set_status(job, 'live', 'Keine Änderung nötig')
    set_status(job, 'publishing', 'Wird veröffentlicht')
    rc, out = sh(['git', '-C', repo, 'pull', '--rebase', '--quiet', 'origin', 'main'], timeout=120)
    if rc != 0:
        sh(['git', '-C', repo, 'rebase', '--abort'])
        return fail(job, 'Die Änderung passt nicht mehr zum aktuellen Stand der Seite.', out)
    rc, out = sh(['git', '-C', repo, 'push', '--quiet', 'origin', 'HEAD:main'], timeout=120)
    if rc != 0:
        return fail(job, 'Veröffentlichen hat nicht geklappt.', out)
    rc, sha = sh(['git', '-C', repo, 'rev-parse', 'HEAD'])
    job['commit'] = sha.strip()
    st['labels'][job['commit']] = job.get('labelForCommit') or job['title']
    job['deployStart'] = time.time()
    set_status(job, 'deploying', 'Geht online')
    log('pushed', job['id'], job['commit'])


def check_deploy(job, st):
    key = secret('RENDER_API_KEY')
    if time.time() - job.get('deployStart', 0) > DEPLOY_TIMEOUT:
        return fail(job, 'Online-Stellen dauert ungewöhnlich lange.')
    if not key:
        if time.time() - job['deployStart'] > 120:
            set_status(job, 'live', 'Online')
        return
    try:
        deploys = http('GET', f'https://api.render.com/v1/services/{RENDER_SERVICE}/deploys?limit=10', headers={'Authorization': f'Bearer {key}'})
    except Exception as e:
        return log('render api', e)
    for d in deploys:
        d = d.get('deploy', d)
        if (d.get('commit') or {}).get('id') != job['commit']:
            continue
        s = d.get('status')
        if s == 'live':
            try:
                with urllib.request.urlopen(urllib.request.Request(f'{SITE}/?v={int(time.time())}', headers={'user-agent': 'tanzbar-studio-runner'}), timeout=20) as r:
                    ok = r.status == 200
            except Exception:
                ok = False
            if ok:
                set_status(job, 'live', 'Online')
                refresh_versions(st, force=True)
                log('live', job['id'])
                notify(f"Michi hat per Studio eine Änderung an diskret-tanzbar.de beauftragt, sie ist jetzt online: \"{job['title']}\". {job.get('summary', '')} Job: {job.get('dir')}")
        elif s in ('build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed'):
            fail(job, 'Online-Stellen ist fehlgeschlagen.', s)
        return


def advance(st):
    jobs = sorted(st['jobs'].values(), key=lambda j: j['createdAt'])
    for j in [j for j in jobs if j['status'] in ACTIVE]:
        if j['status'] == 'running':
            read_progress(j)
            if time.time() - j.get('startedAt', 0) > RUN_TIMEOUT:
                sh(['systemctl', '--user', 'stop', j['unit']], timeout=60)
                fail(j, 'Der Agent hat zu lange gebraucht.')
            elif time.time() - j.get('startedAt', 0) > 25 and not unit_active(j['unit']):
                finish_run(j, st)
        elif j['status'] == 'deploying':
            check_deploy(j, st)
        elif time.time() - j.get('startedAt', time.time()) > 600:
            fail(j, 'Unterbrochen.')  # interrupted mid-step (runner restart)
    if not any(j['status'] in ACTIVE for j in jobs):
        queued = [j for j in jobs if j['status'] == 'queued']
        if queued:
            try:
                start(queued[0], st)
            except Exception as e:
                fail(queued[0], 'Der Agent konnte nicht starten.', repr(e))


# ---------------------------------------------------------------- previews
PREVIEW_SYS = """You prepare a visual preview of a website change for a non-technical artist.
You get the HTML of one page, the area to show, and optionally a requested change.
Return ONLY a JSON object:
{"selector": "CSS selector of the smallest element that contains the whole area (it must exist in the HTML; prefer section/header/main children with ids or classes)",
 "focus": "CSS selector of the element the change adds or modifies, as it exists AFTER your js ran (give added elements a class so you can select them). Empty when nothing changes.",
 "js": "JavaScript statements that apply the requested change visually in the loaded page (DOM/text/style edits only, no network, no navigation, no alerts). Empty string when no change is requested or it cannot be shown.",
 "note": "German, du-form, 1-2 short sentences for Michi: what the images show (first image = jetzt, second = mit Änderung). If the change could not be shown exactly, say so honestly."}
The page is in German. Keep the site's style when adding elements (reuse existing classes). Images: only existing ones under /assets/img/."""


def make_preview(pv):
    try:
        path = pv['page'] if pv['page'].startswith('/') else '/'
        url = f"{SITE}{path}{'?clean' if path.startswith('/varianten/') else ''}"
        html = urllib.request.urlopen(urllib.request.Request(url, headers={'user-agent': 'tanzbar-studio-runner'}), timeout=20).read().decode('utf-8', 'replace')
        html = re.sub(r'<link rel="icon"[^>]*>', '', html)[:60000]
        user = f"AREA: {pv['area']}\nREQUESTED CHANGE: {pv['change'] or '(none, show the area as it is now)'}\nDEVICE: {pv['device']}\n\nHTML:\n{html}"
        body = {'model': 'grok-4.7', 'messages': [{'role': 'system', 'content': PREVIEW_SYS}, {'role': 'user', 'content': user}],
                'max_tokens': 1800, 'response_format': {'type': 'json_object'}}
        d = http('POST', 'https://api.x.ai/v1/chat/completions', body, headers={'Authorization': f"Bearer {secret('XAI_API_KEY')}"}, timeout=90)
        txt = d['choices'][0]['message']['content']
        plan = json.loads(re.search(r'\{.*\}', txt, re.S).group(0))
        job = {'url': url, 'selector': str(plan.get('selector') or ''), 'focus': str(plan.get('focus') or ''), 'js': str(plan.get('js') or '') if pv['change'] else '', 'device': pv['device']}
        chrome = f"{HOME}/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell"
        rc, out = sh(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'lechonk',
                      f'cd ~/tanzbar-studio-preview && CHROME_PATH=$HOME/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell timeout 120 node preview.mjs'],
                     timeout=150, inp=json.dumps(job))
        m = re.search(r'\{"images".*\}\s*$', out, re.S)
        if rc != 0 or not m:
            raise RuntimeError(f'render failed: {out[-300:]}')
        images = json.loads(m.group(0))['images']
        res = {'status': 'done', 'images': [{'label': im['label'], 'mime': 'image/jpeg', 'b64': im['b64']} for im in images], 'note': str(plan.get('note') or '')[:400]}
        del chrome
    except Exception as e:
        log('preview failed', pv['id'], repr(e)[:300])
        res = {'status': 'failed', 'error': 'Vorschau fehlgeschlagen'}
    try:
        http('POST', f"{API}/api/runner/preview/{pv['id']}", res, headers=AUTH(), timeout=60)
        log('preview', pv['id'], res['status'])
    except Exception as e:
        log('preview post failed', pv['id'], e)
    finally:
        INFLIGHT.discard(pv['id'])


# ---------------------------------------------------------------- sync
def prune(st):
    keep = sorted(st['jobs'].values(), key=lambda j: j['createdAt'])[-30:]
    st['jobs'] = {j['id']: j for j in keep}


def sync(st):
    queued = [j for j in sorted(st['jobs'].values(), key=lambda j: j['createdAt']) if j['status'] == 'queued']
    pos = {j['id']: i + 1 for i, j in enumerate(queued)}
    versions = [{**v, 'label': st['labels'].get(v['sha']) or v.get('label') or ''} for v in st['versions']]
    resp = http('POST', f'{API}/api/runner/sync', {'jobs': [public(j, pos.get(j['id'])) for j in st['jobs'].values()], 'versions': versions, 'profile': st['profile']}, headers=AUTH())
    if resp.get('profile'):
        st['profile'] = resp['profile']
    for r in resp.get('claim', []):
        if r['id'] in st['jobs']:
            continue
        st['jobs'][r['id']] = {**r, 'status': 'queued', 'updatedAt': now(), 'progress': [{'t': now(), 'text': 'Auftrag angenommen'}], 'summary': '', 'error': ''}
        log('claimed', r['id'], r.get('type'), r.get('title'))
        if r.get('type', 'change') == 'change':
            notify(f"Michi hat per Studio eine Änderung an diskret-tanzbar.de bestätigt: \"{r.get('title')}\". Der Agent setzt sie um und veröffentlicht sie selbst.")
    for pv in resp.get('previews', []):
        if pv['id'] not in INFLIGHT:
            INFLIGHT.add(pv['id'])
            POOL.submit(make_preview, pv)


def main():
    if not SECRET:
        sys.exit('RUNNER_SECRET missing')
    st = load()
    st['labels'].setdefault('5e54b4a', 'Design „Beton“ als Startseite, Studio eingebaut')
    st['labels'].setdefault('7b6f9f4', 'Design „Afterhour“ (Nr. 10) als Startseite, Varianten raus aus dem Menü')
    log('runner up', API)
    while True:
        try:
            refresh_versions(st)
            advance(st)
            prune(st)
            save(st)
            sync(st)
            save(st)
        except Exception as e:
            log('loop error', repr(e)[:300])
        time.sleep(POLL)


if __name__ == '__main__':
    main()
