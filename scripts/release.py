#!/usr/bin/env python3
"""Canonical source exports and explicit release staleness. No publication or history changes."""
import argparse
import fnmatch
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile

MANIFEST = 'release-manifest.json'
POLICY = 'scripts/release-policy.json'
DEFAULT_CANDIDATE = 'release/public-0.1.0-rc.2'
VALIDATION = {'checks': 'not_run', 'cleanInstall': 'not_run', 'secretReview': 'not_recorded', 'assetReview': 'not_recorded'}


def git(*args, data=None):
    return subprocess.check_output(['git', *args], input=data, stderr=subprocess.PIPE)


def resolve(ref):
    return git('rev-parse', '--verify', ref + '^{commit}').decode().strip()


def tree(ref):
    entries = {}
    for row in git('ls-tree', '-rz', '--full-tree', ref).split(b'\0'):
        if not row:
            continue
        meta, name = row.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        entries[name.decode()] = {'mode': mode, 'kind': kind, 'blob': oid}
    return entries


def read_policy(ref):
    value = json.loads(git('show', ref + ':' + POLICY))
    if value.get('schemaVersion') != 1 or value.get('repository') != 'Sc4rville/weevils':
        raise ValueError('unsupported release policy')
    if not isinstance(value.get('exclude'), list) or not all(isinstance(p, str) for p in value['exclude']):
        raise ValueError('invalid exclusion policy')
    return value


def excluded(name, policy):
    parts = PurePosixPath(name).parts
    if any(p in {'.git', '.ssh', '.claude', '.codex', '.config', '.local', 'node_modules'} for p in parts):
        return True
    if any(p.startswith('.env') and p != '.env.example' for p in parts):
        return True
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in policy['exclude'])


def selected(ref, policy):
    return {name: entry for name, entry in tree(ref).items() if not excluded(name, policy)}


def differences(source, candidate):
    return {
        'added': sorted(source.keys() - candidate.keys()),
        'changed': sorted(p for p in source.keys() & candidate.keys() if source[p] != candidate[p]),
        'removed': sorted(candidate.keys() - source.keys()),
    }


def status(canonical_ref, candidate_ref=None, manifest_file=None, tested=None, running=None):
    canonical = resolve(canonical_ref)
    policy = read_policy(canonical)
    current = selected(canonical, policy)
    if manifest_file:
        manifest = json.loads(Path(manifest_file).read_text())
        if manifest.get('schemaVersion') != 1 or manifest.get('repository') != policy['repository']:
            raise ValueError('invalid candidate manifest')
        source = resolve(manifest['sourceCommit'])
        candidate_commit = None
        candidate = {p: {'mode': f['mode'], 'kind': 'blob', 'blob': f['gitBlob']} for p, f in manifest['files'].items()}
        checks = manifest.get('validation', {'status': 'not_recorded'})
    else:
        candidate_commit = resolve(candidate_ref or DEFAULT_CANDIDATE)
        candidate = selected(candidate_commit, policy)
        if MANIFEST in candidate:
            manifest = json.loads(git('show', candidate_commit + ':' + MANIFEST))
            source = resolve(manifest['sourceCommit'])
            checks = manifest.get('validation', {'status': 'not_recorded'})
            candidate.pop(MANIFEST)
        else:
            legacy = policy.get('legacyCandidates', {}).get(candidate_commit)
            source = resolve(legacy['sourceCommit']) if legacy else None
            checks = {'status': 'legacy_evidence' if legacy else 'not_recorded', **(legacy or {})}
    delta = differences(current, candidate)
    return {
        'repository': policy['repository'], 'canonicalCommit': canonical,
        'candidateCommit': candidate_commit, 'candidateSourceCommit': source,
        'candidateReachableCommits': int(git('rev-list', '--count', candidate_commit)) if candidate_commit else None,
        'stale': source != canonical or any(delta.values()),
        'sourceParity': not any(delta.values()),
        'differenceCounts': {k: len(v) for k, v in delta.items()},
        'validation': checks,
        'reportedTestedCommit': resolve(tested) if tested else None,
        'reportedRunningCommit': resolve(running) if running else None,
        'reportedTestedMatchesCanonical': resolve(tested) == canonical if tested else None,
        'reportedRunningMatchesCanonical': resolve(running) == canonical if running else None,
        'note': 'Reported revisions are inputs, not proof that tests passed or that a server was inspected.',
    }


def export(source_ref, output):
    source = resolve(source_ref)
    policy = read_policy(source)
    all_entries = tree(source)
    entries = selected(source, policy)
    if MANIFEST in entries:
        raise ValueError('export canonical source, not an earlier generated candidate')
    files, data = {}, {}
    for name, entry in sorted(entries.items()):
        if entry['kind'] != 'blob' or entry['mode'] not in {'100644', '100755'}:
            raise ValueError('symlinks and submodules require explicit release review')
        if name.startswith('/') or '..' in PurePosixPath(name).parts:
            raise ValueError('unsafe source path')
        raw = git('cat-file', 'blob', entry['blob'])
        data[name] = raw
        files[name] = {'mode': entry['mode'], 'gitBlob': entry['blob'], 'sha256': hashlib.sha256(raw).hexdigest()}
    manifest = {
        'schemaVersion': 1, 'repository': policy['repository'],
        'sourceCommit': source, 'sourceTree': git('rev-parse', source + '^{tree}').decode().strip(),
        'policySha256': hashlib.sha256(git('show', source + ':' + POLICY)).hexdigest(),
        'historyIncluded': False, 'publication': 'private-preparation-only',
        'excludedFileCount': len(all_entries) - len(entries),
        'validation': VALIDATION,
        'files': files,
    }
    data[MANIFEST] = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    timestamp = int(git('show', '-s', '--format=%ct', source))
    output = Path(output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # New immutable artifact only; never overwrite a previous candidate, ref or user's files.
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.release-', delete=False) as temp:
        temporary = Path(temp.name)
    try:
        with temporary.open('wb') as raw:
            with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as zipped:
                with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                    for name, content in sorted(data.items()):
                        info = tarfile.TarInfo('weevils/' + name)
                        info.size = len(content)
                        info.mtime = timestamp
                        info.mode = 0o755 if entries.get(name, {}).get('mode') == '100755' else 0o644
                        archive.addfile(info, io.BytesIO(content))
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return {'sourceCommit': source, 'archiveSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'files': len(files), 'excludedFiles': manifest['excludedFileCount'], 'validation': manifest['validation']}


def verify(archive_file):
    with tarfile.open(archive_file, 'r:gz') as archive:
        members = archive.getmembers()
        names = [m.name for m in members]
        if len(names) != len(set(names)) or any(not m.isfile() for m in members):
            raise ValueError('duplicate or non-regular archive entries')
        raw = archive.extractfile('weevils/' + MANIFEST).read()
        manifest = json.loads(raw)
        source = resolve(manifest['sourceCommit'])
        policy = read_policy(source)
        expected = selected(source, policy)
        if manifest.get('repository') != policy['repository'] or manifest.get('schemaVersion') != 1:
            raise ValueError('invalid manifest')
        if manifest.get('validation') != VALIDATION or manifest.get('historyIncluded') is not False or manifest.get('publication') != 'private-preparation-only':
            raise ValueError('export metadata cannot assert publication or validation approval')
        if manifest.get('sourceTree') != git('rev-parse', source + '^{tree}').decode().strip():
            raise ValueError('source tree mismatch')
        if manifest.get('policySha256') != hashlib.sha256(git('show', source + ':' + POLICY)).hexdigest():
            raise ValueError('policy mismatch')
        if set(names) != {'weevils/' + p for p in expected} | {'weevils/' + MANIFEST} or set(manifest['files']) != set(expected):
            raise ValueError('archive does not match the canonical file set')
        for name, entry in expected.items():
            member = archive.getmember('weevils/' + name)
            content = archive.extractfile(member).read()
            evidence = manifest['files'][name]
            if content != git('cat-file', 'blob', entry['blob']) or member.mode != (0o755 if entry['mode'] == '100755' else 0o644):
                raise ValueError('archive file differs from canonical source')
            if evidence != {'mode': entry['mode'], 'gitBlob': entry['blob'], 'sha256': hashlib.sha256(content).hexdigest()}:
                raise ValueError('file manifest mismatch')
    return {'sourceCommit': source, 'sourceParity': True, 'files': len(expected),
            'archiveSha256': hashlib.sha256(Path(archive_file).read_bytes()).hexdigest(),
            'validation': manifest['validation'], 'historyIncluded': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('status')
    check.add_argument('--canonical', default='origin/main', help='Fetch origin/main before comparing with GitHub.')
    choice = check.add_mutually_exclusive_group()
    choice.add_argument('--candidate', default=None)
    choice.add_argument('--manifest')
    check.add_argument('--tested', help='Reported tested source SHA; does not assert test success.')
    check.add_argument('--running', help='Reported running source SHA; does not inspect a service.')
    pack = commands.add_parser('export')
    pack.add_argument('--source', default='origin/main')
    pack.add_argument('--output', required=True)
    validate = commands.add_parser('verify')
    validate.add_argument('archive')
    args = parser.parse_args()
    try:
        if args.command == 'status':
            result = status(args.canonical, args.candidate, args.manifest, args.tested, args.running)
        elif args.command == 'export':
            result = export(args.source, args.output)
        else:
            result = verify(args.archive)
        print(json.dumps(result, indent=2))
        return 2 if result.get('stale') else 0
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        # Do not echo Git stderr, source contents, account configuration or credentials.
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
