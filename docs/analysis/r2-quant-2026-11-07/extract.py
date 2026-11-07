import gzip,json,re
from pathlib import Path
from pypdf import PdfReader
base=Path(__file__).resolve().parent
index=json.loads((base/'supplement-index.json').read_text(encoding='utf-8'))
for row in index['records']:
    if row.get('error'):continue
    try:
        reader=PdfReader(base/'pdf-temp'/row['file'])
        row['pages']=[{'page':i+1,'text':p.extract_text()} for i,p in enumerate(reader.pages)]
        row['order_pages']=[p['page'] for p in row['pages'] if re.search(r'单笔.{0,30}(?:上限|限额)|递增|起点销售金额',p['text'])]
    except Exception as e:row['extract_error']=str(e)
with gzip.open(base/'supplement.json.gz','wt',encoding='utf-8') as f:json.dump(index,f,ensure_ascii=True)
print(json.dumps({'documents':len(index['records']),'extracted':sum('pages'in r for r in index['records'])}))
