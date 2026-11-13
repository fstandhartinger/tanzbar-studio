#!/usr/bin/env python3
"""Generate the studio link token + runner secret (once) and push the gateway env to Coolify via the sandy-deploy MCP.
Prints no secret values."""
import json, os, re, secrets, hashlib, subprocess, sys, time
APP = 'ww6p2ebred3mavrw0bz3esqv'
CFG = os.path.expanduser('~/.config/tanzbar-studio')
runner_env = os.path.join(CFG, 'runner.env'); link_file = os.path.join(CFG, 'link.txt')
os.umask(0o077)
if not os.path.exists(runner_env):
    with open(runner_env, 'w') as f:
        f.write(f"RUNNER_SECRET={secrets.token_urlsafe(32)}\nSTUDIO_API=https://tanzbar-studio.app.mintapis.com\n")
if not os.path.exists(link_file):
    with open(link_file, 'w') as f:
        f.write(f"https://diskret-tanzbar.de/#studio={secrets.token_urlsafe(24)}\n")
runner_secret = re.search(r'^RUNNER_SECRET=(.+)$', open(runner_env).read(), re.M).group(1).strip()
token = open(link_file).read().strip().split('#studio=')[1]
xai = ''
for line in open(os.path.expanduser('~/.config/dev-secrets.env')):
    m = re.match(r'^export XAI_API_KEY=(.*)$', line.strip())
    if m: xai = m.group(1).strip().strip('"').strip("'")
if not xai: sys.exit('XAI_API_KEY missing')
def dev(name):
    for line in open(os.path.expanduser('~/.config/dev-secrets.env')):
        m = re.match(rf'^export {name}=(.*)$', line.strip())
        if m: return m.group(1).strip().strip('"').strip("'")
    return ''
envs = {'STUDIO_TOKEN_SHA256': hashlib.sha256(token.encode()).hexdigest(), 'RUNNER_SECRET': runner_secret, 'XAI_API_KEY': xai}
only = sys.argv[1:]
for k in ('GROQ_API_KEY', 'OPENAI_API_KEY'):
    if dev(k): envs[k] = dev(k)
if only: envs = {k: v for k, v in envs.items() if k in only}
p = subprocess.Popen(['/usr/local/bin/sandy-deploy-mcp-client'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def rpc(obj):
    p.stdin.write(json.dumps(obj) + '\n'); p.stdin.flush()
def read(i):
    while True:
        line = p.stdout.readline()
        if not line: sys.exit('mcp closed')
        try: m = json.loads(line)
        except Exception: continue
        if m.get('id') == i: return m
rpc({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'tanzbar-setup', 'version': '1'}}}); read(1)
rpc({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
i = 10
for k, v in envs.items():
    i += 1
    rpc({'jsonrpc': '2.0', 'id': i, 'method': 'tools/call', 'params': {'name': 'upsert_env', 'arguments': {
        'resource_type': 'application', 'resource_uuid': APP, 'key': k, 'value': v, 'confirm': True,
        'idempotency_key': f'tanzbar-env-{k.lower()}-{int(time.time())}'}}})
    r = read(i)
    txt = json.dumps(r.get('result', r.get('error')))[:200]
    print(k, 'ok' if '"ok": true' in txt or '\\"ok\\":true' in txt else 'CHECK: ' + re.sub(r'[A-Za-z0-9_\-]{30,}', '<redacted>', txt))
p.stdin.close(); p.terminate()
