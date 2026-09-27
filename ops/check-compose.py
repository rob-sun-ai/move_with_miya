#!/usr/bin/env python3
"""Checks invariants of docker-compose.prod.yml that `compose config` cannot.

Run from the repository root with the production variables exported, as in
CI's production-config job.
"""
import json
import os
import subprocess
import sys

APPS = {
    'user-service': 'user-migrate',
    'backend': None,
    'classes-service': 'classes-migrate',
    'registration-service': 'registration-migrate',
    'frontend': None,
}
MIGRATIONS = {job: app for app, job in APPS.items() if job}

config = json.loads(
    subprocess.run(
        ['docker', 'compose', '-f', 'docker-compose.prod.yml', 'config',
         '--format', 'json'],
        check=True, capture_output=True, text=True,
    ).stdout
)
services = config['services']
release = os.environ.get('RELEASE_VERSION') or 'development'
failures = []


def check(condition, message):
    print(('ok   ' if condition else 'FAIL ') + message)
    if not condition:
        failures.append(message)


published = sorted(
    name for name, service in services.items() if service.get('ports')
)
check(published == ['nginx'], f'only nginx publishes ports (got {published})')
check(
    sorted(int(port['published']) for port in services['nginx']['ports'])
    == [80, 443],
    'nginx publishes exactly ports 80 and 443',
)

for name, service in services.items():
    if name in MIGRATIONS:
        continue
    check(
        service.get('restart') == 'unless-stopped',
        f'{name} restarts unless stopped',
    )

for app, job in APPS.items():
    service = services[app]
    check(
        service.get('image') == f'move-with-miya/{app}:{release}',
        f'{app} image is tagged with the release',
    )
    check('healthcheck' in service, f'{app} has a healthcheck')
    if job:
        check(
            service['depends_on'].get(job, {}).get('condition')
            == 'service_completed_successfully',
            f'{app} waits for {job} to succeed',
        )

for job, app in MIGRATIONS.items():
    service = services[job]
    check(
        service.get('image') == services[app]['image'],
        f'{job} reuses the {app} image',
    )
    check('build' not in service, f'{job} does not build a separate image')
    check(service.get('pull_policy') == 'never', f'{job} never pulls')
    check(service.get('restart') == 'no', f'{job} runs once')
    check(
        service.get('command') == ['npx', 'prisma', 'migrate', 'deploy'],
        f'{job} applies migrations',
    )

for upstream in ('backend', 'frontend', 'user-service'):
    check(
        services['nginx']['depends_on'].get(upstream, {}).get('condition')
        == 'service_healthy',
        f'nginx waits for a healthy {upstream}',
    )

if failures:
    sys.exit(f'{len(failures)} compose check(s) failed')
print('Compose checks passed.')
