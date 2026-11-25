'use strict';
// PWA de gastos compartidos, fase 2: alta por enlace, apunte manual y lista del periodo.
// El móvil no guarda datos propios salvo el token y la URL de la API (diseño §4.2).

var CLAVE = 'gc_config';
var $ = function (id) { return document.getElementById(id); };
var config = null;

function leerConfig() { try { return JSON.parse(localStorage.getItem(CLAVE)); } catch (e) { return null; } }
function guardarConfig(c) { try { localStorage.setItem(CLAVE, JSON.stringify(c)); } catch (e) { /* sin almacenamiento: no hay alta */ } }

// El enlace de alta lleva #alta=<token>&api=<url>. Se guarda y se borra de la barra de direcciones.
function procesarAlta() {
  var h = new URLSearchParams(location.hash.slice(1));
  if (h.get('alta') && h.get('api')) {
    guardarConfig({ token: h.get('alta'), api: h.get('api') });
    history.replaceState(null, '', location.pathname);
  }
}

// Alta pegando el enlace: necesario cuando la app está instalada como icono y el enlace se abre en el navegador
// (en iPhone el icono y Safari no comparten almacenamiento).
function altaPegada(ev) {
  ev.preventDefault();
  var texto = $('f-enlace').value.trim();
  $('msg-alta').textContent = '';
  var i = texto.indexOf('#');
  var h = new URLSearchParams(i >= 0 ? texto.slice(i + 1) : '');
  if (h.get('alta') && h.get('api')) {            // enlace antiguo entero
    return terminarAlta({ token: h.get('alta'), api: h.get('api') });
  }
  if (texto.indexOf('/') >= 0 || texto.indexOf('=') >= 0) {
    $('msg-alta').textContent = 'Escribe solo el código (8 letras y números), no el enlace.'; return;
  }
  // Código corto: se canjea en el servidor por el token. La API está junto a la página: .../gastos/api
  var api = window.GC_API || (location.origin + location.pathname.replace(/[^\/]*$/, '') + 'api');
  fetch(api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ accion: 'canjear', codigo: texto }) })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r.ok) { $('msg-alta').textContent = r.error === 'demasiados_intentos' ? 'Demasiados intentos. Espera unos minutos.' : 'Código no válido o caducado. Pide otro a Juan.'; return; }
      terminarAlta({ token: r.token, api: api });
    })
    .catch(function () { $('msg-alta').textContent = 'No se puede conectar con el servidor. ¿Está Tailscale activo?'; });
}

function terminarAlta(c) {
  guardarConfig(c);
  config = leerConfig();
  if (!config) { $('msg-alta').textContent = 'Este navegador no deja guardar datos (¿pestaña privada?).'; return; }
  $('form-alta').reset();
  cargar();
}

function llamar(cuerpo) {
  // text/plain evita el preflight CORS, que Apps Script no contesta
  return fetch(config.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ token: config.token }, cuerpo)) })
    .then(function (r) { return r.json(); });
}

var euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
var fechaCorta = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' });

function mostrar(vista) {
  ['alta', 'lista', 'form'].forEach(function (v) { $('vista-' + v).classList.toggle('oculto', v !== vista); });
  $('nuevo').classList.toggle('oculto', vista !== 'lista');
}

function pintar(r) {
  $('quien').textContent = 'Sesión de ' + r.yo;
  $('periodo').textContent = r.periodo.nombre;
  var s = r.saldo;
  $('saldo').textContent = s.deudor ? s.deudor + ' debe a ' + s.acreedor + ': ' + euros.format(s.importe) : 'Saldo a cero';
  $('totales').textContent = 'Ana ' + euros.format(s.total_ana) + ' · Juan ' + euros.format(s.total_juan);
  var cont = $('lista');
  cont.textContent = '';
  r.movimientos.filter(function (m) { return !m.anulado; })
    .sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; })
    .forEach(function (m) {
      var fila = document.createElement('div'); fila.className = 'fila';
      var c = document.createElement('div'); c.className = 'c';
      var t = document.createElement('div'); t.textContent = m.concepto;
      var d = document.createElement('div'); d.className = 'chip';
      d.textContent = m.pagador + ' · ' + fechaCorta.format(new Date(m.fecha)) + (m.reparto === '100-otro' ? ' · 100 % del otro' : '');
      c.append(t, d);
      var i = document.createElement('div'); i.className = 'i' + (m.importe_imputado < 0 ? ' neg' : '');
      i.textContent = euros.format(m.importe_imputado);
      fila.append(c, i);
      cont.append(fila);
    });
  mostrar('lista');
}

function cargar() {
  return llamar({ accion: 'listar' }).then(function (r) {
    if (!r.ok) { if (r.error === 'no_autorizado') { localStorage.removeItem(CLAVE); config = null; mostrar('alta'); } return; }
    pintar(r);
  }).catch(function () { $('quien').textContent = 'Sin conexión: no se puede cargar la lista'; });
}

// Acepta "12,50" o una expresión simple "65,8-6,6". Devuelve null si no es válida.
function evaluarImporte(texto) {
  var t = texto.replace(/\s/g, '').replace(/,/g, '.');
  if (!/^[0-9.+\-*\/()]+$/.test(t)) return null;
  try {
    var v = Function('"use strict";return (' + t + ')')();   // la expresión ya está limitada a dígitos y operadores
    return isFinite(v) ? { valor: Math.round(v * 100) / 100, expresion: /^-?[0-9.]+$/.test(t) ? '' : t } : null;
  } catch (e) { return null; }
}

function idNuevo() {
  var b = new Uint8Array(12); crypto.getRandomValues(b);
  return 'm' + Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
}

var idEnCurso = null;   // el mismo id en los reintentos evita duplicados (diseño §5)

function guardar(ev) {
  ev.preventDefault();
  var imp = evaluarImporte($('f-importe').value);
  $('msg').textContent = '';
  if (!imp || imp.valor === 0) { $('msg').textContent = 'El importe no es válido.'; return; }
  idEnCurso = idEnCurso || idNuevo();
  $('guardar').disabled = true;
  llamar({ accion: 'anadir', mov: { id: idEnCurso, concepto: $('f-concepto').value, fecha: $('f-fecha').value,
    importe_imputado: imp.valor, expresion: imp.expresion, reparto: $('f-reparto').value } })
    .then(function (r) {
      if (!r.ok) { $('msg').textContent = 'No se ha guardado: ' + (r.detalle || r.error); return; }
      idEnCurso = null; $('form').reset(); pintar(r);
    })
    .catch(function () { $('msg').textContent = 'Sin conexión. Vuelve a pulsar Guardar cuando tengas cobertura; no se duplicará.'; })
    .then(function () { $('guardar').disabled = false; });
}

function hoy() { var d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

document.addEventListener('DOMContentLoaded', function () {
  procesarAlta();
  config = leerConfig();
  $('nuevo').addEventListener('click', function () { $('f-fecha').value = hoy(); mostrar('form'); $('f-concepto').focus(); });
  $('cancelar').addEventListener('click', function () { idEnCurso = null; mostrar('lista'); });
  $('form').addEventListener('submit', guardar);
  $('form-alta').addEventListener('submit', altaPegada);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  if (config) cargar(); else mostrar('alta');
});
