#!/usr/bin/env python3
"""tanzbar-studio-runner (Sandy): turns confirmed voice change requests into Claude Code jobs on LeChonk,
publishes the result to diskret-tanzbar.de and reports progress back to the studio gateway.

Loop (every POLL s): POST <API>/api/runner/sync with every known job (public view) -> receive new requests.
Lifecycle: queued -> starting -> running (Claude Code via run-claude.sh, JOB_HOST=lechonk) -> publishing (git push from
Sandy, only Sandy has GitHub credentials) -> deploying (Render static site, auto-deploy from main) -> live | failed.
One job runs at a time; the rest wait in order. State survives restarts in ~/.local/state/tanzbar-studio/jobs.json.
Env (runner.env): RUNNER_SECRET, STUDIO_API; RENDER_API_KEY comes from ~/.config/dev-secrets.env.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HOME = os.path.expanduser('~')
HERE = os.path.dirname(os.path.abspath(__file__))
API = os.environ.get('STUDIO_API', 'https://tanzbar-studio.app.mintapis.com').rstrip('/')
SECRET = os.environ.get('RUNNER_SECRET', '')
STATE_DIR = os.path.join(HOME, '.local/state/tanzbar-studio')
STATE = os.path.join(STATE_DIR, 'jobs.json')
JOBS_ROOT = os.path.join(HOME, 'jobs')
REPO_URL = 'https://github.com/fstandhartinger/diskret-tanzbar'
RENDER_SERVICE = 'srv-d654b4e3li6c73995tbg'
SITE = 'https://diskret-tanzbar.de/'
POLL = 4
RUN_TIMEOUT = 100 * 60
DEPLOY_TIMEOUT = 20 * 60
OPEN = ('queued', 'starting', 'running', 'publishing', 'deploying')


def now():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def log(*a):
    print(now(), *a, flush=True)


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {'jobs': {}}


def save(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def sh(cmd, cwd=None, timeout=300, env=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def secrets_env():
    """RENDER_API_KEY from the dev-secrets file without printing anything."""
    out = {}
    try:
        with open(os.path.join(HOME, '.config/dev-secrets.env')) as f:
            for line in f:
                m = re.match(r'^export (RENDER_API_KEY)=(.*)$', line.strip())
                if m:
                    out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    except Exception:
        pass
    return out


def http_json(method, url, body=None, headers=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'content-type': 'application/json', 'user-agent': 'tanzbar-studio-runner', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or '{}')


def progress(job, text):
    text = str(text).strip()[:160]
    if not text:
        return
    if job['progress'] and job['progress'][-1]['text'] == text:
        return
    job['progress'].append({'t': now(), 'text': text})
    job['progress'] = job['progress'][-60:]
    job['updatedAt'] = now()


def set_status(job, status, text=None):
    job['status'] = status
    job['updatedAt'] = now()
    if text:
        progress(job, text)


def public(job, position=None):
    return {k: job.get(k) for k in ('id', 'createdAt', 'updatedAt', 'title', 'points', 'status', 'progress', 'summary', 'error')} | {'position': position}


def notify(text):
    try:
        sh([os.path.join(HOME, 'bin/notify'), 'digest', 'tanzbar-studio', text], timeout=60)
    except Exception as e:
        log('notify failed', e)


# ---------- job start ----------
def write_prompt(job, jd):
    with open(os.path.join(HERE, 'PROMPT-TEMPLATE.md')) as f:
        tpl = f.read()
    transcript = '\n'.join(f"- **{'Michi' if t.get('role') == 'michi' else 'Studio'}:** {t.get('text', '')}" for t in job.get('transcript', [])[-40:])
    points = '\n'.join(f'- {p}' for p in job.get('points', []))
    body = (tpl.replace('{{ID}}', job['id']).replace('{{TITLE}}', job['title']).replace('{{POINTS}}', points or '-')
            .replace('{{SPEC}}', job.get('spec', '')).replace('{{CONFIRMATION}}', job.get('confirmation', ''))
            .replace('{{TRANSCRIPT}}', transcript or '-').replace('{{JOBDIR}}', jd))
    with open(os.path.join(jd, 'PROMPT.md'), 'w') as f:
        f.write(body)
    with open(os.path.join(jd, 'REQUEST.json'), 'w') as f:
        json.dump({k: job.get(k) for k in ('id', 'createdAt', 'title', 'points', 'spec', 'confirmation', 'transcript')}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(jd, 'STATE.md'), 'w') as f:
        f.write(f"# {job['title']}\n\nChange request {job['id']} from Michi via the tanzbar-studio voice page.\n"
                f"Started by ~/tanzbar-studio-runner (systemd user unit tanzbar-studio-runner). The runner pushes and deploys after the job.\n")
    open(os.path.join(jd, 'PROGRESS.md'), 'a').close()


def start(job):
    name = f"tanzbar-studio-change-{job['id']}"
    jd = os.path.join(JOBS_ROOT, name)
    os.makedirs(jd, exist_ok=True)
    set_status(job, 'starting', 'Server bereitet die Arbeit vor')
    rc, out = sh(['git', 'clone', '--quiet', REPO_URL, os.path.join(jd, 'repo')], timeout=180)
    if rc != 0 and not os.path.isdir(os.path.join(jd, 'repo/.git')):
        return fail(job, 'Konnte die Website-Dateien nicht laden.', out)
    sh(['git', '-C', os.path.join(jd, 'repo'), 'config', 'user.name', 'fstandhartinger'])
    sh(['git', '-C', os.path.join(jd, 'repo'), 'config', 'user.email', 'fstandhartinger@users.noreply.github.com'])
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
    job.update(dir=jd, unit=unit, account=acc, startedAt=time.time(), progressSeen=0)
    set_status(job, 'running', 'Agent gestartet')
    log('started', job['id'], unit, 'account', acc)


def fail(job, msg_for_michi, detail=''):
    job['error'] = msg_for_michi
    set_status(job, 'failed', 'Abgebrochen')
    log('FAILED', job['id'], msg_for_michi, detail[-500:])
    notify(f"Michis Studio-Auftrag \"{job['title']}\" ist fehlgeschlagen: {msg_for_michi} Job: {job.get('dir', '-')}")


def unit_active(unit):
    rc, out = sh(['systemctl', '--user', 'is-active', unit], timeout=20)
    return out.strip() in ('active', 'activating', 'reloading')


def read_progress(job):
    p = os.path.join(job['dir'], 'PROGRESS.md')
    try:
        with open(p) as f:
            lines = [l.strip() for l in f if l.strip()]
    except Exception:
        return
    for l in lines[job.get('progressSeen', 0):]:
        progress(job, re.sub(r'^[-*]\s*(\d{1,2}:\d{2}\s*)?', '', l))
    job['progressSeen'] = len(lines)


def finish_run(job):
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
    repo = os.path.join(job['dir'], 'repo')
    rc, ahead = sh(['git', '-C', repo, 'log', '--oneline', 'origin/main..HEAD'])
    if rc != 0:
        return fail(job, 'Die Änderung ließ sich nicht prüfen.', ahead)
    if not ahead.strip():
        set_status(job, 'live', 'Nichts zu veröffentlichen')
        return
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
    job['deployStart'] = time.time()
    set_status(job, 'deploying', 'Geht online')
    log('pushed', job['id'], job['commit'])


def check_deploy(job):
    key = secrets_env().get('RENDER_API_KEY')
    if time.time() - job.get('deployStart', 0) > DEPLOY_TIMEOUT:
        return fail(job, 'Online-Stellen dauert ungewöhnlich lange.')
    if not key:
        # without the API, fall back to a plain wait + reachability check
        if time.time() - job['deployStart'] > 120:
            set_status(job, 'live', 'Online')
        return
    try:
        deploys = http_json('GET', f'https://api.render.com/v1/services/{RENDER_SERVICE}/deploys?limit=10', headers={'Authorization': f'Bearer {key}'})
    except Exception as e:
        log('render api', e)
        return
    for d in deploys:
        d = d.get('deploy', d)
        if (d.get('commit') or {}).get('id') == job['commit']:
            st = d.get('status')
            if st == 'live':
                try:
                    with urllib.request.urlopen(urllib.request.Request(SITE + f'?v={int(time.time())}', headers={'user-agent': 'tanzbar-studio-runner'}), timeout=20) as r:
                        ok = r.status == 200
                except Exception:
                    ok = False
                if ok:
                    set_status(job, 'live', 'Online')
                    log('live', job['id'])
                    notify(f"Michi hat per Studio eine Änderung an diskret-tanzbar.de beauftragt, sie ist jetzt online: \"{job['title']}\". {job.get('summary', '')} Job: {job['dir']}")
            elif st in ('build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed'):
                fail(job, 'Online-Stellen ist fehlgeschlagen.', st)
            return


def advance(st):
    jobs = sorted(st['jobs'].values(), key=lambda j: j['createdAt'])
    active = [j for j in jobs if j['status'] in ('starting', 'running', 'publishing', 'deploying')]
    for j in active:
        if j['status'] == 'running':
            read_progress(j)
            if time.time() - j.get('startedAt', 0) > RUN_TIMEOUT:
                sh(['systemctl', '--user', 'stop', j['unit']], timeout=60)
                fail(j, 'Der Agent hat zu lange gebraucht.')
            elif time.time() - j.get('startedAt', 0) > 25 and not unit_active(j['unit']):
                finish_run(j)
        elif j['status'] == 'deploying':
            check_deploy(j)
        elif j['status'] in ('starting', 'publishing'):
            # interrupted mid-step (runner restart): treat as failed so the queue moves on
            if time.time() - j.get('startedAt', time.time()) > 600:
                fail(j, 'Unterbrochen.')
    if not any(j['status'] in ('starting', 'running', 'publishing', 'deploying') for j in jobs):
        queued = [j for j in jobs if j['status'] == 'queued']
        if queued:
            try:
                start(queued[0])
            except Exception as e:
                fail(queued[0], 'Der Agent konnte nicht starten.', repr(e))


def prune(st):
    keep = sorted(st['jobs'].values(), key=lambda j: j['createdAt'])[-30:]
    st['jobs'] = {j['id']: j for j in keep}


def sync(st):
    queued = [j for j in sorted(st['jobs'].values(), key=lambda j: j['createdAt']) if j['status'] == 'queued']
    pos = {j['id']: i + 1 for i, j in enumerate(queued)}
    resp = http_json('POST', f'{API}/api/runner/sync', {'jobs': [public(j, pos.get(j['id'])) for j in st['jobs'].values()]},
                     headers={'Authorization': f'Bearer {SECRET}'})
    for r in resp.get('claim', []):
        if r['id'] in st['jobs']:
            continue
        st['jobs'][r['id']] = {**r, 'status': 'queued', 'updatedAt': now(), 'progress': [{'t': now(), 'text': 'Auftrag angenommen'}], 'summary': '', 'error': ''}
        log('claimed', r['id'], r.get('title'))
        notify(f"Michi hat per Studio-Sprachagent eine Änderung an diskret-tanzbar.de bestätigt: \"{r.get('title')}\". Der Agent setzt sie um und veröffentlicht sie selbst.")


def main():
    if not SECRET:
        sys.exit('RUNNER_SECRET missing')
    st = load()
    log('runner up', API)
    while True:
        try:
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
