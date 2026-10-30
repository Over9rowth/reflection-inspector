"""Two real CC BY 2.0 photos for P0 smoke tests; not an accuracy benchmark."""
import hashlib, json, pathlib, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/fixtures'
OUT.mkdir(parents=True, exist_ok=True)
records = []
for name, slug, path in [
    ('mirror.jpg','Bright_bathroom_with_mirror_and_sink.jpg','0/05'),
    ('glass.jpg','Modern_bathroom_with_wooden_and_glass_parts.jpg','9/9b'),
]:
    url = f'https://upload.wikimedia.org/wikipedia/commons/{path}/{slug}'
    target = OUT / name
    request = urllib.request.Request(url, headers={'User-Agent':'ReflectionInspectorLocalValidation/0.1'})
    with urllib.request.urlopen(request, timeout=120) as response, target.open('wb') as stream:
        while chunk := response.read(1024*1024): stream.write(chunk)
    records.append({'file':name,'author':'Shixart1985','license':'CC BY 2.0','licenseUrl':'https://creativecommons.org/licenses/by/2.0/','sourcePage':f'https://commons.wikimedia.org/wiki/File:{slug}','url':url,'changes':'none; original download','bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'purpose':'real-photo smoke test; no frozen human annotations'})
(OUT/'sources.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
