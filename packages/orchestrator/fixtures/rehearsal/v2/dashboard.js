export const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live click analytics</title>
<style>
:root{--bg:#0e131c;--panel:#161d2b;--rule:#2b3548;--ink:#e9eef8;--dim:#8493ad;--amber:#ffb454;--go:#58d5a0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:60rem;margin:0 auto;padding:1rem}
h1{font-size:1.05rem;letter-spacing:.18em;text-transform:uppercase;margin:0 0 .7rem;font-weight:700}
.total{font-size:clamp(2.6rem,11vw,5rem);line-height:1;color:var(--amber);font-variant-numeric:tabular-nums;margin:0}
.total-label{color:var(--dim);font-size:.75rem;letter-spacing:.18em;text-transform:uppercase}
.card{background:var(--panel);border:1px solid var(--rule);padding:.8rem;margin-bottom:.7rem}
form{display:flex;gap:.5rem;flex-wrap:wrap}
input,button{font:inherit;padding:.6rem .7rem;background:var(--bg);color:var(--ink);border:1px solid var(--rule)}
input{flex:1 1 16rem;min-width:0}
button{border-color:var(--amber);color:var(--amber);cursor:pointer}
button:active{background:var(--amber);color:var(--bg)}
table{width:100%;border-collapse:collapse;table-layout:fixed}
td{padding:.45rem .5rem .45rem 0;vertical-align:middle}
td.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--amber);width:4.5rem;font-size:1.15rem}
td.l{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:7rem}
/* The bar column takes whatever is left — a shrink-to-fit cell gives the bars
   nothing to grow into, which makes the chart look broken at a glance. */
td.b{width:auto}
.bar{height:20px;background:var(--go);min-width:3px;transition:width .35s ease}
/* On a phone the three fixed columns leave the bars almost no room, and the
   bars are the whole point. The label goes; the code still identifies the row. */
@media(max-width:560px){
  td.lab{display:none}
  td.l{width:5.5rem}
  td.n{width:3.4rem}
}
.spark{display:flex;align-items:flex-end;gap:2px;height:46px}
.spark i{flex:1;background:var(--rule);min-height:2px}
.spark i.hot{background:var(--amber)}
a{color:var(--go)}
.empty{color:var(--dim)}
</style></head><body><div class="wrap">
<h1>Live click analytics</h1>

<div class="card">
  <p class="total-label">Total clicks</p>
  <p class="total" id="total">0</p>
  <div class="spark" id="spark"></div>
  <p class="total-label" style="margin:.5rem 0 0">Clicks per second, last 30s</p>
</div>

<div class="card">
  <table id="rows"><tbody><tr><td class="empty">No links yet.</td></tr></tbody></table>
</div>

<div class="card">
  <form onsubmit="return shorten(event)">
    <input id="u" placeholder="https://example.com" autocomplete="off">
    <input id="lab" placeholder="label (optional)" style="flex:0 1 10rem" autocomplete="off">
    <button>Shorten</button>
  </form>
  <p id="out" class="empty"></p>
</div>
</div>
<script>
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function render(d){
  document.getElementById('total').textContent = d.total;
  const max = Math.max(1, ...d.links.map(l=>l.clicks));
  document.getElementById('rows').innerHTML = d.links.length
    ? '<tbody>' + d.links.slice(0, 12).map(l =>
        '<tr><td class="l"><a href="/'+esc(l.code)+'" target="_blank">/'+esc(l.code)+'</a></td>'+
        '<td class="l lab">'+esc(l.label)+'</td>'+
        '<td class="b"><div class="bar" style="width:'+Math.round(l.clicks/max*100)+'%"></div></td>'+
        '<td class="n">'+l.clicks+'</td></tr>').join('') + '</tbody>'
    : '<tbody><tr><td class="empty">No links yet.</td></tr></tbody>';
  const peak = Math.max(1, ...d.perSecond);
  document.getElementById('spark').innerHTML = d.perSecond
    .map(v => '<i class="'+(v?'hot':'')+'" style="height:'+Math.round(v/peak*100)+'%"></i>').join('');
}
async function shorten(e){
  e.preventDefault();
  const r = await fetch('/api/links',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({url:document.getElementById('u').value,label:document.getElementById('lab').value})});
  const d = await r.json();
  document.getElementById('out').innerHTML = r.ok
    ? 'Created <a href="/'+esc(d.code)+'" target="_blank">/'+esc(d.code)+'</a> — share it and watch the chart.'
    : 'Error: '+esc(d.error);
  return false;
}
// Live updates over SSE, with polling as a fallback if the stream drops.
let es;
function connect(){
  es = new EventSource('/api/stream');
  es.onmessage = ev => render(JSON.parse(ev.data));
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}
connect();
</script></body></html>`;
