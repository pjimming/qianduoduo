const fs = require('fs')
const zlib = require('zlib')
const path = process.argv[2]
const buf = fs.readFileSync(path)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let i = 0
while ((i = buf.indexOf(magic, i)) !== -1) {
  starts.push(i)
  i += 4
}
starts.push(buf.length)
let out = ''
let ok = 0,
  fail = 0
for (let k = 0; k < starts.length - 1; k++) {
  const frame = buf.subarray(starts[k], starts[k + 1])
  try {
    out += zlib.zstdDecompressSync(frame).toString('utf8')
    ok++
  } catch (e) {
    fail++
  }
}
console.log(JSON.stringify({ frames: starts.length - 1, ok, fail, chars: out.length }))
fs.writeFileSync('shots/baijiu-session.jsonl', out)
