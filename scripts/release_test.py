import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release', HERE / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.original = Path.cwd()
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        os.chdir(self.repo)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Release test')
        self.git('config', 'user.email', 'release-test@example.invalid')
        self.write('scripts/release-policy.json', (HERE / 'release-policy.json').read_text())
        self.write('src/app.ts', 'export const version = 1\n')
        self.write('install.sh', '#!/bin/sh\nexit 0\n')
        (self.repo / 'install.sh').chmod(0o755)
        self.write('.env.example', 'EXAMPLE=\n')
        for name in ['.env', '.config/weevils/env', 'content/avatar-memes-20261111/personal.json', 'harness-interface-kit/references/old.png', 'docs/incidents/private.md']:
            self.write(name, 'synthetic-private-sentinel')
        self.commit()
        self.source = release.resolve('HEAD')

    def tearDown(self):
        os.chdir(self.original)
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], stderr=subprocess.PIPE)

    def write(self, name, text):
        p = self.repo / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self):
        self.git('add', '-A')
        self.git('commit', '-qm', 'test source')

    def test_reproducible_history_free_export_uses_committed_bytes_and_excludes_private_inputs(self):
        self.write('src/app.ts', 'uncommitted concurrent edit')
        self.write('untracked-secret.txt', 'untracked-private-sentinel')
        a, b = self.root / 'a.tar.gz', self.root / 'b.tar.gz'
        release.export(self.source, a)
        release.export(self.source, b)
        self.assertEqual(a.read_bytes(), b.read_bytes())
        self.assertEqual(a.stat().st_mode & 0o777, 0o600)
        result = release.verify(a)
        self.assertTrue(result['sourceParity'])
        self.assertFalse(result['historyIncluded'])
        self.assertEqual(result['validation'], release.VALIDATION)
        with tarfile.open(a) as t:
            names = t.getnames()
            self.assertIn('weevils/.env.example', names)
            self.assertNotIn('weevils/.env', names)
            self.assertEqual(t.extractfile('weevils/src/app.ts').read(), b'export const version = 1\n')
            self.assertEqual(t.getmember('weevils/install.sh').mode, 0o755)
            for member in t:
                self.assertNotIn(b'private-sentinel', t.extractfile(member).read())
        self.assertEqual((self.repo / 'src/app.ts').read_text(), 'uncommitted concurrent edit')
        with self.assertRaises(FileExistsError):
            release.export(self.source, a)

    def test_detects_new_canonical_changes_and_keeps_tested_running_revisions_separate(self):
        archive = self.root / 'candidate.tar.gz'
        release.export(self.source, archive)
        with tarfile.open(archive) as t:
            manifest = t.extractfile('weevils/' + release.MANIFEST).read()
        metadata = self.root / 'manifest.json'
        metadata.write_bytes(manifest)
        self.assertFalse(release.status('HEAD', manifest_file=metadata)['stale'])
        self.write('src/app.ts', 'export const version = 2\n')
        self.write('new-product-module/feature.ts', 'export const feature = true\n')
        self.commit()
        state = release.status('HEAD', manifest_file=metadata, tested=self.source, running=self.source)
        self.assertTrue(state['stale'])
        self.assertEqual(state['differenceCounts'], {'added': 1, 'changed': 1, 'removed': 0})
        self.assertFalse(state['reportedTestedMatchesCanonical'])
        self.assertFalse(state['reportedRunningMatchesCanonical'])
        self.assertEqual(state['validation']['checks'], 'not_run')

    def test_rejects_modified_archive_and_symlink_sources(self):
        archive = self.root / 'good.tar.gz'
        release.export(self.source, archive)
        bad = self.root / 'bad.tar.gz'
        with tarfile.open(archive) as original, tarfile.open(bad, 'w:gz') as changed:
            for member in original:
                content = original.extractfile(member).read()
                if member.name == 'weevils/src/app.ts':
                    content = b'changed outside canonical source'
                    member.size = len(content)
                changed.addfile(member, io.BytesIO(content))
        with self.assertRaisesRegex(ValueError, 'differs from canonical'):
            release.verify(bad)
        (self.repo / 'src' / 'leak').symlink_to('/home/private')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            release.export('HEAD', self.root / 'link.tar.gz')

    def test_legacy_unknown_candidate_is_never_reported_current(self):
        state = release.status('HEAD', candidate_ref='HEAD')
        self.assertTrue(state['sourceParity'])
        self.assertTrue(state['stale'])
        self.assertIsNone(state['candidateSourceCommit'])
        self.assertEqual(state['validation']['status'], 'not_recorded')


if __name__ == '__main__':
    unittest.main()
