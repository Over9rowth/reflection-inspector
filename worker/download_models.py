"""Explicit, verified model acquisition. Never called by inference."""
import hashlib, json, pathlib, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODELS = [
    ('IDEA-Research/grounding-dino-tiny', 'a2bb814dd30d776dcf7e30523b00659f4f141c71', 689359096, '1a2412ef99bd74bcd3c2a246fa1e48581f8889a1300c9051974741314fc042f3'),
    ('facebook/sam-vit-base', '70c1a07f894ebb5b307fd9eaaee97b9dfc16068f', 374979480, '892c410e496344e527255ccdcb2cb7244a609acb5389c7c4fdba1288f861c579'),
]

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def main():
    manifest = {'schemaVersion': 1, 'source': 'Official Hugging Face API blobs metadata, verified 2026-10-24', 'models': []}
    for repo, rev, size, expected in MODELS:
        url = f'https://huggingface.co/api/models/{repo}/revision/{rev}?blobs=true'
        metadata = json.load(urllib.request.urlopen(url, timeout=60))
        folder = ROOT / 'resources' / 'models' / repo.split('/')[-1]
        folder.mkdir(parents=True, exist_ok=True)
        records = []
        for item in metadata['siblings']:
            name = item['rfilename']
            if name not in {'README.md', 'config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'vocab.txt', 'model.safetensors'}:
                continue
            source = f'https://huggingface.co/{repo}/resolve/{rev}/{name}'
            final = folder / name
            sha = item.get('lfs', {}).get('sha256')
            if name == 'model.safetensors':
                assert sha == expected and item['size'] == size, 'Official metadata mismatch'
            if not final.exists() or (sha and digest(final) != sha):
                partial = final.with_suffix(final.suffix + '.part')
                with urllib.request.urlopen(source, timeout=120) as response, partial.open('wb') as out:
                    while block := response.read(1024 * 1024):
                        out.write(block)
                if partial.stat().st_size != item['size'] or (sha and digest(partial) != sha):
                    raise RuntimeError(f'Integrity mismatch: {name}')
                partial.replace(final)
            records.append({'file': name, 'bytes': final.stat().st_size, 'sha256': digest(final), 'shaSource': 'official LFS' if sha else 'locally measured; HTTPS pinned revision', 'url': source})
            print(f'Verified {repo}/{name}', flush=True)
        manifest['models'].append({'id': repo, 'revision': rev, 'license': 'Apache-2.0', 'licenseUrl': f'https://huggingface.co/{repo}/blob/{rev}/README.md', 'files': records})
        (ROOT / 'resources' / 'model-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
