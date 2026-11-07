import hashlib,json,zipfile
from pathlib import Path
base=Path(__file__).resolve().parent
index=json.loads((base/'supplement-index.json').read_text(encoding='utf-8'))
with zipfile.ZipFile(base/'prospectuses.zip') as archive:
    assert len(archive.namelist())==len(index['records'])
    for row in index['records']:
        assert hashlib.sha256(archive.read(row['file'])).hexdigest()==row['sha256']
print(json.dumps({'ok':True,'pdf_hashes_verified':len(index['records'])}))
