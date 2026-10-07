"""Run isolated tests; optional suites never use real Anthropic credentials."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--suite', choices=['basic', 'network', 'integration'], default='basic')
    parser.add_argument('--node', default=os.environ.get('NODE_EXE') or shutil.which('node'))
    parser.add_argument('--code', help='VS Code Code.exe; overrides VSCODE_EXE')
    args = parser.parse_args()
    if not args.node:
        parser.error('Node.js 24 required; pass --node or set NODE_EXE.')
    env = dict(os.environ)
    if args.code:
        env['VSCODE_EXE'] = args.code
    tests = ['test_guardian_lifecycle.cjs', 'test_guardian_launcher.cjs']
    if args.suite != 'basic':
        subprocess.run([sys.executable, str(ROOT / 'tests/make_test_certificate.py')], check=True)
        env['NODE_EXTRA_CA_CERTS'] = str(ROOT / '.test-work/test-cert.pem')
        tests = ['test_stock_guardian.cjs' if args.suite == 'network' else 'vscode_guardian_integration.cjs']
    for test in tests:
        subprocess.run([args.node, str(ROOT / 'tests' / test)], cwd=ROOT, env=env, check=True)


if __name__ == '__main__':
    main()
