/**
 * The minimal panel at `/_sandbox`: the last requests, the webhook deliveries with their answer, and a form to
 * simulate an incoming message. One self-contained page (no external resources); it polls the `/_sandbox` JSON
 * routes every two seconds.
 */
export function panelHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox de Funnelchat</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --text: #1d2433; --muted: #5b6475; --line: #dfe3ea; --ok: #1b7f3b; --bad: #b42318; --warn: #a15c00; --accent: #0b6e4f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #1a202a; --text: #e6e9ef; --muted: #9aa4b5; --line: #2b3340; --ok: #4cc27a; --bad: #ff7b72; --warn: #e3a44a; --accent: #3fb68b; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 16px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  header span { color: var(--muted); }
  main { display: grid; gap: 16px; padding: 16px; grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 1100px) { main { grid-template-columns: 360px minmax(0, 1fr) minmax(0, 1fr); } }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  label { display: block; margin: 8px 0 2px; color: var(--muted); font-size: 12px; }
  input, select, textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
  button { margin-top: 10px; padding: 7px 12px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
  button.secondary { background: transparent; color: var(--muted); border: 1px solid var(--line); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border-top: 1px solid var(--line); padding: 6px 0; }
  li:first-child { border-top: 0; }
  details summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  code, pre { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); padding: 8px; border-radius: 6px; max-height: 260px; overflow: auto; }
  .s2 { color: var(--ok); } .s4, .s5, .sx { color: var(--bad); } .s3 { color: var(--warn); }
  .muted { color: var(--muted); }
  #result { margin-top: 8px; }
</style>
</head>
<body>
<header><h1>Sandbox de Funnelchat</h1><span>Nada sale a WhatsApp: todo queda en memoria.</span><span id="summary"></span></header>
<main>
  <section>
    <h2>Mensaje entrante</h2>
    <form id="inbound">
      <label for="phone">Teléfono de quien escribe</label>
      <input id="phone" name="phone" value="5491100000000" autocomplete="off">
      <label for="name">Nombre (si el contacto es nuevo)</label>
      <input id="name" name="name" placeholder="Opcional">
      <label for="device">Número que recibe</label>
      <select id="device" name="device_id"><option value="3">3 · oficial (Cloud API)</option><option value="4">4 · QR</option></select>
      <label for="text">Texto</label>
      <textarea id="text" name="text" rows="3">Hola, quiero más información</textarea>
      <button type="submit">Mandar mensaje entrante</button>
      <button type="button" class="secondary" id="reset">Reiniciar el estado</button>
    </form>
    <div id="result" class="muted"></div>
  </section>
  <section><h2>Últimos pedidos</h2><ul id="requests"><li class="muted">Todavía no hay pedidos.</li></ul></section>
  <section><h2>Entregas de webhooks</h2><ul id="deliveries"><li class="muted">Todavía no hay entregas.</li></ul></section>
</main>
<script>
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (status) => (status ? 's' + String(status)[0] : 'sx');
const pretty = (v) => { try { return esc(JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2)); } catch { return esc(v); } };
const open = new Set();
function remember(list) { list.querySelectorAll('details').forEach((d) => d.open ? open.add(d.dataset.key) : open.delete(d.dataset.key)); }
async function refresh() {
  try {
    const [req, del, st] = await Promise.all(['requests', 'deliveries', 'state'].map((p) => fetch('/_sandbox/' + p + (p === 'state' ? '' : '?limit=40')).then((r) => r.json())));
    const reqList = document.getElementById('requests'); remember(reqList);
    reqList.innerHTML = req.data.length ? req.data.map((r) => '<li><details data-key="r' + r.id + '"' + (open.has('r' + r.id) ? ' open' : '') + '><summary><b class="' + cls(r.status) + '">' + r.status + '</b><code>' + esc(r.method) + ' ' + esc(r.path) + '</code><span class="muted">' + r.durationMs + ' ms · ' + esc(r.at.slice(11, 19)) + '</span></summary>' + (r.requestBody !== null && r.requestBody !== undefined ? '<p class="muted">Pedido</p><pre>' + pretty(r.requestBody) + '</pre>' : '') + '<p class="muted">Respuesta</p><pre>' + pretty(r.responseBody) + '</pre></details></li>').join('') : '<li class="muted">Todavía no hay pedidos.</li>';
    const delList = document.getElementById('deliveries'); remember(delList);
    delList.innerHTML = del.data.length ? del.data.map((d) => '<li><details data-key="d' + d.id + '"' + (open.has('d' + d.id) ? ' open' : '') + '><summary><b class="' + cls(d.response_status) + '">' + esc(d.response_status ?? d.error) + '</b><code>' + esc(d.event_type) + '</code><span class="muted">intento ' + d.attempt + ' · ' + esc(d.url) + (d.next_attempt_at ? ' · reintento ' + esc(d.next_attempt_at.slice(11, 19)) : '') + '</span></summary><p class="muted">Cuerpo firmado</p><pre>' + pretty(d.request_body) + '</pre><p class="muted">Respuesta de tu servidor</p><pre>' + esc(d.response_body ?? d.error) + '</pre></details></li>').join('') : '<li class="muted">Todavía no hay entregas.</li>';
    document.getElementById('summary').textContent = st.counts.contacts + ' contactos · ' + st.counts.messages + ' mensajes · ' + st.counts.subscriptions + ' suscripciones';
  } catch (e) { document.getElementById('summary').textContent = 'Sin conexión con el sandbox'; }
}
document.getElementById('inbound').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const body = { phone: f.get('phone'), device_id: Number(f.get('device_id')), text: f.get('text') };
  if (f.get('name')) body.name = f.get('name');
  const res = await fetch('/_sandbox/inbound/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  document.getElementById('result').innerHTML = res.ok ? 'Mensaje ' + json.message.id + ' del contacto ' + json.contact.id + ' · evento ' + esc(json.event.id) + ' a ' + json.event.subscriptions + ' suscripciones' : '<span class="s4">' + esc(json.message) + '</span>';
  refresh();
});
document.getElementById('reset').addEventListener('click', async () => { await fetch('/_sandbox/reset', { method: 'POST' }); document.getElementById('result').textContent = 'Estado reiniciado.'; refresh(); });
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
