"""Seeded negative controls. Inputs are synthetic and confined to temp folders."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import checks
import licenses

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("packaging_build", REPO / "packaging/build.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class HarnessAcceptance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bh-wp14-test-")
        self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name, text):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p

    def test_network_seeded_fetch(self):
        self.file("ui/src/page.js", 'fetch("https://example.invalid/leak");')
        self.assertTrue(checks.static_network(self.root))

    def test_network_seeded_relative_fetch_and_rust_client(self):
        self.file("app/pages/page.js", 'window["fetch"]("/leak");')
        self.file("collector/src/new.rs", 'use reqwest::Client;')
        self.assertGreaterEqual(len(checks.static_network(self.root)), 2)

    def test_network_seeded_loopback_outside_receiver(self):
        self.file("world/src/new.js", 'fetch("http://127.0.0.1:8888");')
        self.assertTrue(checks.static_network(self.root))

    def test_network_inert_schema_and_svg_are_not_requests(self):
        self.file("app/src-tauri/tauri.conf.json", '{"$schema":"https://schema.tauri.app/config/2"}')
        self.file("ui/src/ui/dom.js", 'const SVG_NS = "http://www.w3.org/2000/svg";')
        self.assertEqual(checks.static_network(self.root), [])

    def test_network_checks_new_files_and_ignores_dependencies_and_fixtures(self):
        self.file("ui/node_modules/demo/a.js", 'fetch("https://example.invalid");')
        self.file("collector/tests/demo.rs", 'TcpStream::connect("example.invalid:80");')
        self.file("ui/src/page.js", 'const local = 1;')
        self.assertEqual(checks.static_network(self.root), [])
        self.file("sidecar/src/leak.rs", 'std::net::UdpSocket::bind("0.0.0.0:0");')
        self.assertTrue(checks.static_network(self.root))

    def test_network_rust_contract_enum_is_not_browser_eventsource(self):
        self.file('collector/src/ok.rs', 'use busyholm_contracts::EventSource; let source = EventSource::Hook;')
        self.assertEqual(checks.static_network(self.root), [])
        self.file('ui/src/new.js', 'new EventSource("/events");')
        self.assertTrue(checks.static_network(self.root))

    def test_network_mutation_of_audited_receiver_is_rejected(self):
        self.file('collector/src/receiver.rs', (REPO / 'collector/src/receiver.rs').read_text())
        self.assertEqual(checks.static_network(self.root), [])
        with (self.root / 'collector/src/receiver.rs').open('a') as f:
            f.write('\nfn leak() { reqwest::Client::new(); }\n')
        self.assertTrue(checks.static_network(self.root))

    def test_network_test_module_mask_does_not_hide_following_product_code(self):
        self.file('collector/src/new.rs', '#[cfg(test)] mod tests { fn probe() { TcpStream::connect("example.invalid:80"); } }\nfn leak() { reqwest::Client::new(); }')
        issues = checks.static_network(self.root)
        self.assertTrue(any(i.get('match') == 'reqwest' for i in issues))

    def plugin_text(self):
        return (REPO / 'collector-wp06/plugin/busyholm.js').read_text()

    def test_network_loopback_plugin_client_is_accepted(self):
        # The OpenCode plugin posts allowlisted events to the 127.0.0.1 receiver with redirect: "error" (see tools/verify/README.md).
        self.file('collector-wp06/plugin/busyholm.js', self.plugin_text())
        self.assertEqual(checks.static_network(self.root), [])

    def test_network_loopback_plugin_rejects_non_loopback_url(self):
        text = self.plugin_text().replace('http://127.0.0.1:${rt.port}', 'http://203.0.113.9:${rt.port}')
        self.assertNotEqual(text, self.plugin_text())
        self.file('collector-wp06/plugin/busyholm.js', text)
        self.assertTrue(checks.static_network(self.root))

    def test_network_loopback_plugin_rejects_missing_or_other_redirect(self):
        text = self.plugin_text()
        self.assertIn('redirect: "error",', text)
        self.file('collector-wp06/plugin/busyholm.js', text.replace('redirect: "error",', ''))
        self.assertTrue(checks.static_network(self.root))
        self.file('collector-wp06/plugin/busyholm.js', text.replace('redirect: "error",', 'redirect: "follow",'))
        self.assertTrue(checks.static_network(self.root))

    def test_network_loopback_plugin_exemption_is_one_file_only(self):
        self.file('collector-wp06/plugin/copy.js', self.plugin_text())
        self.assertTrue(checks.static_network(self.root))
        self.file('collector-wp06/plugin/busyholm.js', self.plugin_text() + '\nfetch("https://example.invalid/leak");\n')
        self.assertTrue(checks.static_network(self.root))

    def test_runtime_seeded_non_loopback_connection(self):
        raw = 'p41\nf7\ntIPv4\nPTCP\nn127.0.0.1:49000->203.0.113.9:443\n'
        self.assertTrue(checks.socket_violations(raw))

    def test_runtime_seeded_wildcard_listener_and_udp(self):
        for endpoint in ['*:8080', '0.0.0.0:8080', '[::]:8080', '203.0.113.9:53']:
            self.assertTrue(checks.socket_violations(f'p41\nf7\ntIPv4\nPUDP\nn{endpoint}\n'))

    def test_runtime_loopback_receiver_and_client(self):
        raw = 'p41\nf7\ntIPv4\nPTCP\nn127.0.0.1:49000\nf8\nn127.0.0.1:49000->127.0.0.1:12345\n'
        self.assertEqual(checks.socket_violations(raw), [])

    def test_privacy_seeded_leak_in_nested_file_and_binary(self):
        self.file("outputs/data/backups/ledger.json", '{"message":"WP14_SECRET"}')
        p = self.file("outputs/app.stderr", "quiet")
        p.write_bytes(b'\x00WP14_SECRET\xff')
        self.assertEqual(len(checks.scan_canaries([self.root / "outputs"], ["WP14_SECRET"])), 2)

    def test_privacy_clean_counts_and_missing_output_fail_closed(self):
        self.file("outputs/ledger.json", '{"turns":1}')
        self.assertEqual(checks.scan_canaries([self.root / "outputs"], ["WP14_SECRET"]), [])
        self.assertTrue(checks.scan_canaries([self.root / "absent"], ["WP14_SECRET"]))

    def test_privacy_does_not_follow_output_symlinks(self):
        self.file("outputs/clean.json", "{}")
        outside = self.file("input/secret.json", "WP14_SECRET")
        (self.root / "outputs/link").symlink_to(outside)
        self.assertTrue(checks.scan_canaries([self.root / "outputs"], ["WP14_SECRET"]))

    def test_data_inventory_includes_coverage_and_rejects_unknown(self):
        self.file("data/coverage.json", "{}")
        self.assertEqual(inventory_errors(self.root / "data"), [])
        self.file("data/raw-prompt.json", "{}")
        self.assertTrue(inventory_errors(self.root / "data"))

    def test_dash_seeded_docs_and_user_copy(self):
        self.file("README.md", "Busyholm\u2014your island")
        self.file("ui/src/copy.js", 'const title = "30\u201345 seconds";')
        self.assertEqual(len(checks.dash_lint(self.root)), 2)

    def test_dash_clean_copy_and_internal_notes(self):
        self.file("README.md", "Busyholm: your island")
        self.file("ui/src/copy.js", '// internal\u2014comment\nconst title = "30 to 45 seconds";')
        self.file("research/notes.md", "source\u2014verbatim")
        self.assertEqual(checks.dash_lint(self.root), [])

    def test_licence_seeded_missing_and_disallowed(self):
        for expression in [None, "", "AGPL-3.0-only", "GPL-3.0-only", "MIT AND AGPL-3.0-only", "MIT OR", "UNKNOWN"]:
            self.assertFalse(checks.license_allowed(expression), expression)

    def test_licence_alternatives_and_required_notices(self):
        for expression in ["MIT", "MIT OR Apache-2.0", "MIT/Apache-2.0", "(MIT OR Apache-2.0) AND Unicode-3.0", "Apache-2.0 WITH LLVM-exception OR MIT", "MPL-2.0", "OFL-1.1"]:
            self.assertTrue(checks.license_allowed(expression), expression)

    def test_generated_notices_detect_seeded_missing_dependency_and_font_licences(self):
        for name in ['Cargo.toml', 'Cargo.lock', 'app/src-tauri/Cargo.toml', 'app/src-tauri/Cargo.lock']:
            self.file(name, '')
        for name in ['package-lock.json', 'app/package-lock.json', 'world/art/package-lock.json']:
            self.file(name, '{"packages": {}}')
        self.file('ui/src/fonts/example.woff2', 'synthetic font')
        self.file('ui/src/fonts/OFL.txt', 'SIL OPEN FONT LICENSE Version 1.1')
        self.file('dependency/Cargo.toml', '')
        self.file('dependency/LICENSE', 'MIT License\nCopyright synthetic fixture')
        package = dict(name='synthetic', version='1.0.0', source='registry+synthetic', license='MIT',
                       license_file=None, rust_version='1.85', manifest_path=str(self.root / 'dependency/Cargo.toml'))
        with patch.object(licenses, 'REPO', self.root), patch.object(licenses, 'metadata', return_value={'packages': [package]}):
            self.assertTrue(licenses.generate(self.root / 'notices', 'aarch64-apple-darwin')['passed'])
            package['license'] = None
            self.assertFalse(licenses.generate(self.root / 'notices', 'aarch64-apple-darwin')['passed'])
            package['license'] = 'MIT'
            (self.root / 'dependency/LICENSE').unlink()
            self.assertFalse(licenses.generate(self.root / 'notices', 'aarch64-apple-darwin')['passed'])
            self.file('dependency/LICENSE', 'MIT License\nCopyright synthetic fixture')
            (self.root / 'ui/src/fonts/OFL.txt').unlink()
            self.assertFalse(licenses.generate(self.root / 'notices', 'aarch64-apple-darwin')['passed'])

    MIT_TEXT = ('MIT License\nCopyright (c) synthetic fixture\n\nPermission is hereby granted, free of charge, to any person\n'
                'obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software.')

    def licence_world(self, archive_text=None):
        """A synthetic repo with one registry crate whose installed archive may lack licence text."""
        for name in ['Cargo.toml', 'Cargo.lock', 'app/src-tauri/Cargo.toml', 'app/src-tauri/Cargo.lock']:
            self.file(name, '')
        for name in ['package-lock.json', 'app/package-lock.json', 'world/art/package-lock.json']:
            self.file(name, '{"packages": {}}')
        self.file('dependency/Cargo.toml', '')
        if archive_text: self.file('dependency/LICENSE', archive_text)
        return dict(name='synthetic', version='1.0.0', source='registry+synthetic', license='MIT',
                    license_file=None, rust_version='1.85', manifest_path=str(self.root / 'dependency/Cargo.toml'))

    def run_licences(self, package):
        with patch.object(licenses, 'REPO', self.root), patch.object(licenses, 'metadata', return_value={'packages': [package]}):
            return licenses.generate(self.root / 'notices', 'aarch64-apple-darwin')

    def test_licence_override_supplies_text_the_archive_lacks(self):
        package = self.licence_world()
        self.file('packaging/licence-overrides/synthetic-1.0.0/LICENSE', self.MIT_TEXT)
        result = self.run_licences(package)
        self.assertTrue(result['passed'], result['errors'])
        self.assertIn('Permission is hereby granted', (self.root / 'notices/THIRD-PARTY-NOTICES.txt').read_text())

    def test_licence_crate_with_neither_archive_text_nor_override_still_fails(self):
        package = self.licence_world()
        self.assertFalse(self.run_licences(package)['passed'])
        # An override for another version, or for another crate, does not count.
        self.file('packaging/licence-overrides/synthetic-0.9.0/LICENSE', self.MIT_TEXT)
        self.file('packaging/licence-overrides/other-1.0.0/LICENSE', self.MIT_TEXT)
        self.assertFalse(self.run_licences(package)['passed'])

    def test_licence_override_that_does_not_match_the_declared_licence_fails(self):
        package = self.licence_world()
        self.file('packaging/licence-overrides/synthetic-1.0.0/LICENSE', 'Apache License\nVersion 2.0, January 2004\n'
                  'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
        result = self.run_licences(package)
        self.assertFalse(result['passed'])
        self.assertTrue(any('does not match' in e['error'] for e in result['errors']), result['errors'])

    def test_licence_text_matching_follows_spdx_alternatives(self):
        apache = 'Apache License\nVersion 2.0, January 2004\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'
        self.assertTrue(licenses.text_satisfies('MIT OR Apache-2.0', [apache]))
        self.assertFalse(licenses.text_satisfies('MIT AND Apache-2.0', [apache]))
        self.assertTrue(licenses.text_satisfies('MIT AND Apache-2.0', [apache, self.MIT_TEXT]))
        self.assertFalse(licenses.text_satisfies('MIT', ['All rights reserved.']))
        self.assertFalse(licenses.text_satisfies('Made-Up-1.0', [self.MIT_TEXT]))

    def test_committed_licence_overrides_match_their_recorded_licence(self):
        folders = sorted(p for p in (REPO / 'packaging/licence-overrides').iterdir() if p.is_dir())
        self.assertGreaterEqual(len(folders), 21)
        for folder in folders:
            spdx = next(l.split(': ', 1)[1] for l in (folder / 'SOURCE.txt').read_text().splitlines() if l.startswith('spdx: '))
            texts = [f.read_text() for f in licenses.notice_files(folder)]
            self.assertTrue(texts, folder.name)
            self.assertTrue(licenses.text_satisfies(spdx, texts), f'{folder.name}: {spdx}')

    def test_packaging_seeded_missing_notice_and_installer_in_depot(self):
        self.file("depot/busyholm.exe", "MZ synthetic")
        self.assertTrue(packaging.validate_depot(self.root / "depot", "windows"))
        self.file("depot/THIRD-PARTY-NOTICES.txt", "MIT synthetic notice")
        self.file("depot/OFL.txt", "SIL OPEN FONT LICENSE Version 1.1")
        self.file("depot/busyholm-hook.exe", "MZ synthetic")
        self.assertEqual(packaging.validate_depot(self.root / "depot", "windows"), [])
        self.file("depot/Busyholm-setup.exe", "MZ installer")
        self.assertTrue(packaging.validate_depot(self.root / "depot", "windows"))

    def test_packaging_plan_is_unsigned_offline_and_uses_real_collector(self):
        for target in ["macos", "windows-x64", "windows-arm64", "linux"]:
            plan = packaging.build_plan(REPO, target, self.root / "out")
            text = str(plan)
            self.assertIn("collector", text)
            self.assertIn("--offline", text)
            self.assertIn("--locked", text)
            self.assertIn("--no-sign", text)
            self.assertIn("--remap-path-prefix=", text)
            self.assertNotIn("npx", text)
            self.assertNotIn("steamcmd", text.lower())
        env = licenses.cargo_environment(REPO, "/Users/alice")
        self.assertIn("--remap-path-prefix=/Users/alice=~", env["CARGO_ENCODED_RUSTFLAGS"])
        self.assertIn(f"--remap-path-prefix={REPO}=busyholm", env["CARGO_ENCODED_RUSTFLAGS"])


def inventory_errors(folder):
    return checks.inventory(folder)["errors"]


if __name__ == "__main__":
    unittest.main()
