"""Build the Windows helpers and local VSIX using pinned, verified dependencies."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import urllib.request
import zipfile
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'extension'


def dependencies():
    records = json.loads((SOURCE / 'dependency-integrity.json').read_text(encoding='utf-8'))
    for record in records:
        name = record['package']
        expected_source = f"https://registry.npmjs.org/{name}/-/{name}-{record['version']}.tgz"
        if record['source'] != expected_source or '/' in name or '..' in name:
            raise RuntimeError('Unexpected dependency source: ' + name)
        with urllib.request.urlopen(expected_source, timeout=30) as response:
            content = response.read(10_000_001)
        if len(content) > 10_000_000:
            raise RuntimeError('Dependency exceeds size limit: ' + name)
        algorithm, digest = record['integrity'].split('-', 1)
        if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(content).digest()).decode() != digest:
            raise RuntimeError('Dependency integrity mismatch: ' + name)
        target = SOURCE / 'node_modules' / name
        # Overwrite only entries from the verified archive; never extract links.
        with tarfile.open(fileobj=io.BytesIO(content), mode='r:gz') as archive:
            for member in archive.getmembers():
                relative = PurePosixPath(member.name)
                if not relative.parts or relative.parts[0] != 'package' or '..' in relative.parts:
                    raise RuntimeError('Unexpected archive path')
                if not member.isfile():
                    continue
                output = target.joinpath(*relative.parts[1:])
                if not output.resolve().is_relative_to(target.resolve()):
                    raise RuntimeError('Archive path escaped package')
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(archive.extractfile(member).read())
        metadata = json.loads((target / 'package.json').read_text(encoding='utf-8'))
        if metadata['name'] != name or metadata['version'] != record['version']:
            raise RuntimeError('Dependency metadata mismatch: ' + name)
        print(name, record['version'], 'SHA-512 verified', flush=True)


def compile_helpers():
    compiler = Path(os.environ.get('CSC_EXE', str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')))
    if not compiler.is_file():
        raise RuntimeError('Windows .NET Framework C# compiler not found; set CSC_EXE.')
    subprocess.run([str(compiler), '/nologo', '/target:exe', '/out:' + str(SOURCE / 'ClaudePluginGuard.exe'), str(SOURCE / 'ClaudePluginGuard.cs')], check=True)
    subprocess.run([str(compiler), '/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/out:' + str(ROOT / 'CodeClashLauncher.exe'), str(ROOT / 'CodeClashLauncher.cs')], check=True)


def package():
    metadata = json.loads((SOURCE / 'package.json').read_text(encoding='utf-8'))
    manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
 <Metadata><Identity Id="{escape(metadata['name'])}" Version="{escape(metadata['version'])}" Language="en-US" Publisher="{escape(metadata['publisher'])}" TargetPlatform="win32-x64"/><DisplayName>{escape(metadata['displayName'])}</DisplayName><Description xml:space="preserve">{escape(metadata['description'])}</Description><Tags>claude,clash,proxy</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(metadata['engines']['vscode'])}"/></Properties><License>extension/LICENSE</License></Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
 <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
    types = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="exe" ContentType="application/octet-stream"/></Types>'''
    target = ROOT / f"claude-clash-guardian-{metadata['version']}.vsix"
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('extension.vsixmanifest', manifest)
        archive.writestr('[Content_Types].xml', types)
        for file in sorted(SOURCE.rglob('*')):
            if file.is_file():
                archive.write(file, 'extension/' + file.relative_to(SOURCE).as_posix())
    print(target)


if __name__ == '__main__':
    dependencies()
    compile_helpers()
    package()
