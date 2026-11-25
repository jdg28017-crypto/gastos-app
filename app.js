'use strict';
// PWA de gastos compartidos, fase 2: alta por enlace, apunte manual y lista del periodo.
// El móvil no guarda datos propios salvo el token y la URL de la API (diseño §4.2).

var VERSION_APP = 'v11';   // se enseña en la cabecera; subirla a la vez que VERSION de sw.js
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
  $('quien').textContent = 'Sesión de ' + r.yo + ' · app ' + VERSION_APP + ' · servidor ' + (r.version || 'antiguo (sin versión)');
  $('periodo').textContent = r.periodo.nombre;
  var s = r.saldo;
  $('saldo').textContent = s.deudor ? s.deudor + ' debe a ' + s.acreedor + ': ' + euros.format(s.importe) : 'Saldo a cero';
  $('totales').textContent = 'Ana ' + euros.format(s.total_ana) + ' · Juan ' + euros.format(s.total_juan);
  ultimaRespuesta = r;
  var cont = $('lista');
  cont.textContent = '';
  var verAnulados = $('ver-anulados').checked;
  var ocultos = r.movimientos.filter(function (m) { return m.anulado; }).length;
  $('n-anulados').textContent = ocultos ? '(' + ocultos + ')' : '';
  r.movimientos.filter(function (m) { return verAnulados || !m.anulado; })
    .sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; })
    .forEach(function (m) {
      var fila = document.createElement('div'); fila.className = 'fila' + (m.anulado ? ' anulada' : '');
      var c = document.createElement('div'); c.className = 'c';
      var t = document.createElement('div'); t.className = 't'; t.textContent = m.concepto;
      var d = document.createElement('div'); d.className = 'chip';
      d.textContent = m.pagador + ' · ' + fechaCorta.format(new Date(m.fecha)) + (m.reparto === '100-otro' ? ' · 100 % del otro' : '') + (m.anulado ? ' · ANULADO' : '');
      c.append(t, d);
      var i = document.createElement('div'); i.className = 'i' + (m.importe_imputado < 0 ? ' neg' : '');
      i.textContent = euros.format(m.importe_imputado);
      if (m.tiene_ticket && !m.anulado) c.append(botonMini('Ver ticket', '', function (b) { verTicket(m.id, b); }));
      if (m.pagador === r.yo) {   // cada uno corrige solo lo que apuntó
        if (m.anulado) {
          c.append(botonMini('Restaurar', 'sec', function (b) { cambiarEstado('restaurar', m.id, b); }));
          c.append(botonMini('Borrar para siempre', 'peligro', function (b) {
            if (confirm('¿Borrar para siempre este gasto?\n\n' + m.concepto + ' · ' + euros.format(m.importe_imputado) + '\n\nSale de la lista y de la hoja, y su foto va a la papelera de Drive. En la pestaña Historial queda una copia de los datos.')) cambiarEstado('eliminar', m.id, b);
          }));
        } else {
          c.append(botonMini('Editar', 'sec', function () { abrirEdicion(m); }));
          c.append(botonMini('Anular', 'peligro', function (b) {
            if (confirm('¿Anular este gasto?\n\n' + m.concepto + ' · ' + euros.format(m.importe_imputado) + '\n\nDejará de contar en el saldo. Se puede restaurar.')) cambiarEstado('anular', m.id, b);
          }));
        }
      }
      fila.append(c, i);
      cont.append(fila);
    });
  mostrar('lista');
}

var ultimaRespuesta = null;

function botonMini(texto, clase, accion) {
  var b = document.createElement('button'); b.type = 'button'; b.className = 'mini ' + clase; b.textContent = texto;
  b.addEventListener('click', function () { accion(b); });
  return b;
}

function cambiarEstado(accion, id, boton) {
  boton.disabled = true;
  llamar({ accion: accion, id: id }).then(function (r) {
    if (!r.ok) { mostrarAvisos(['No se ha podido completar: ' + (r.detalle || r.error)]); return; }
    mostrarAvisos([]); pintar(r);
  }).catch(function () { mostrarAvisos(['Sin conexión: no se ha podido cambiar el gasto.']); })
    .then(function () { boton.disabled = false; });
}

// Edición: el mismo formulario, con los datos del gasto. La foto no se cambia (se anula y se apunta de nuevo).
var editandoId = null;

// Sin foto: los dos botones (hacer foto / escanear). Con foto: solo «Repetir foto».
function botonesFoto(hayFoto) {
  $('botones-foto').classList.toggle('oculto', hayFoto);
  $('repetir-foto').classList.toggle('oculto', !hayFoto);
}

function prepararFormulario(edicion) {
  botonesFoto(false);
  $('bloque-foto').classList.toggle('oculto', edicion);
  $('nota-edicion').classList.toggle('oculto', !edicion);
  $('titulo-form').textContent = edicion ? 'Editar gasto' : 'Apuntar gasto';
  $('guardar').textContent = edicion ? 'Guardar cambios' : 'Guardar';
  $('msg').textContent = '';
}

function abrirEdicion(m) {
  editandoId = m.id; idEnCurso = null;
  prepararFormulario(true); limpiarMarcas();
  $('f-concepto').value = m.concepto;
  $('f-importe').value = String(m.expresion || m.importe_imputado).replace(/\./g, ',');
  $('f-fecha').value = m.fecha;
  $('f-reparto').value = m.reparto || '50/50';
  mostrar('form'); $('f-concepto').focus();
}

function cerrarFormulario() {
  editandoId = null; idEnCurso = null; fotoLista = null; propuestaOcr = null; lecturaId++;
  $('form').reset(); $('f-miniatura').classList.add('oculto'); $('f-pdf').classList.add('oculto');
  limpiarMarcas(); prepararFormulario(false); mostrar('lista');
}

var TEXTO_AVISO = {
  ticket_repetido: 'Aviso: esta foto de ticket ya estaba subida en este periodo. Si es un duplicado, avisa para anularlo.',
  posible_duplicado_del_otro: 'Aviso: parece el mismo gasto que ya apuntó la otra persona (mismo concepto, fecha e importe).'
};
function mostrarAvisos(avisos) {
  var el = $('aviso');
  if (!avisos || !avisos.length) { el.classList.add('oculto'); return; }
  el.textContent = avisos.map(function (a) { return TEXTO_AVISO[a] || a; }).join(' ');
  el.classList.remove('oculto');
}

function verTicket(id, boton) {
  boton.disabled = true;
  llamar({ accion: 'ticket', id: id }).then(function (r) {
    if (!r.ok) { mostrarAvisos(['No se ha podido abrir el ticket.']); return; }
    var pdf = r.mime === 'application/pdf';
    $('visor-img').classList.toggle('oculto', pdf); $('visor-pdf').classList.toggle('oculto', !pdf);
    if (pdf) {
      var bin = atob(r.datos), bytes = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      urlPdf = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      $('visor-pdf').src = urlPdf;
    } else $('visor-img').src = 'data:' + r.mime + ';base64,' + r.datos;
    $('visor').classList.remove('oculto');
  }).catch(function () { mostrarAvisos(['Sin conexión: no se puede abrir el ticket.']); })
    .then(function () { boton.disabled = false; });
}
var urlPdf = null;
function cerrarVisor() {
  $('visor').classList.add('oculto'); $('visor-img').removeAttribute('src'); $('visor-pdf').removeAttribute('src');
  if (urlPdf) { URL.revokeObjectURL(urlPdf); urlPdf = null; }
}

// Límites del servidor: ≈1,9 MB por adjunto (2.600.000 caracteres en base64). Se deja margen.
var MAX_B64 = 2400000, LADO_MAX = 2400;   // lado máximo 2.400 px: un ticket largo necesita resolución para leerse

// JPEG del canvas que quepa en el límite: baja la calidad y, si hace falta, el tamaño.
function jpegQueQuepa(canvas, calidad) {
  var c = canvas, b64;
  for (var intento = 0; intento < 5; intento++) {
    for (var q = calidad; q >= 0.4; q -= 0.1) {
      b64 = c.toDataURL('image/jpeg', q).split(',')[1];
      if (b64.length <= MAX_B64) return b64;
    }
    var r = document.createElement('canvas'); r.width = Math.round(c.width * 0.85); r.height = Math.round(c.height * 0.85);
    r.getContext('2d').drawImage(c, 0, 0, r.width, r.height); c = r;
  }
  return null;
}

// Copia solo para el OCR: luz aplanada, escala de grises y contraste estirado (los tickets térmicos salen pálidos). La que se guarda no se toca.
function copiaParaOCR(canvas) {
  var c = Escaner.aplanarLuz(canvas), g = c.getContext('2d');
  var datos = g.getImageData(0, 0, c.width, c.height), p = datos.data, n = p.length / 4, hist = new Uint32Array(256), i;
  for (i = 0; i < p.length; i += 4) { var y = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0; p[i] = y; hist[y]++; }
  var acum = 0, lo = 0, hi = 255;
  for (i = 0; i < 256; i++) { acum += hist[i]; if (acum >= n * 0.02) { lo = i; break; } }
  acum = 0;
  for (i = 255; i >= 0; i--) { acum += hist[i]; if (acum >= n * 0.02) { hi = i; break; } }
  if (hi - lo < 40) return null;   // imagen casi plana: mejor no tocarla
  var k = 255 / (hi - lo);
  for (i = 0; i < p.length; i += 4) { var v = Math.max(0, Math.min(255, ((p[i] - lo) * k) | 0)); p[i] = p[i + 1] = p[i + 2] = v; }
  g.putImageData(datos, 0, 0);
  return jpegQueQuepa(c, 0.88);
}

// Foto: se escanea en el propio móvil (busca el ticket, lo recorta y lo endereza; si no encuentra un rectángulo creíble usa la foto entera)
// y se reduce. Devuelve { b64 (se guarda), ocr (copia mejorada para leer), vista, recortado }.
function reducirFoto(archivo, opciones) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(archivo);
    var img = new Image();
    img.onload = function () {
      var c = null;
      if (!opciones || opciones.recortar !== false) {
        try { var rect = Escaner.detectarEnImagen(img); if (rect) c = Escaner.recortar(img, rect, LADO_MAX); } catch (e) { c = null; /* sin recorte: foto entera */ }
      }
      var recortado = !!c;
      if (!c) {
        var k = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
        c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      }
      URL.revokeObjectURL(url);
      var b64 = jpegQueQuepa(c, 0.85);
      if (!b64) { reject(new Error('La foto es demasiado grande')); return; }
      var ocr = null; try { ocr = copiaParaOCR(c); } catch (e) { /* sin copia mejorada: se lee la original */ }
      resolve({ b64: b64, ocr: ocr || b64, vista: 'data:image/jpeg;base64,' + b64, recortado: recortado });
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('No se puede leer esa imagen')); };
    img.src = url;
  });
}

// PDF (escáner de documentos del iPhone): se envía tal cual; Google lo lee con OCR igualmente.
function leerPdf(archivo) {
  return new Promise(function (resolve, reject) {
    if (archivo.size > 1900000) { reject(new Error('El PDF ocupa más de 1,9 MB: escanéalo con menos calidad o haz una foto.')); return; }
    var fr = new FileReader();
    fr.onload = function () { var b64 = String(fr.result).split(',')[1]; resolve({ b64: b64, ocr: b64, vista: null, pdf: true, nombre: archivo.name, kb: Math.round(archivo.size / 1024) }); };
    fr.onerror = function () { reject(new Error('No se puede leer ese PDF')); };
    fr.readAsDataURL(archivo);
  });
}

var fotoLista = null;   // { b64, vista } de la foto elegida en el formulario
var propuestaOcr = null, lecturaId = 0;

function info(texto) { $('info-ocr').textContent = texto || ''; }
function marcar(id, confianza) {
  var el = $(id); el.classList.remove('revisar', 'dudoso');
  el.classList.add(confianza === 'baja' || !confianza ? 'dudoso' : 'revisar');   // amarillo: revísalo · rojo: dudoso
}
function limpiarMarcas() { ['f-concepto', 'f-importe', 'f-fecha'].forEach(function (id) { $(id).classList.remove('revisar', 'dudoso'); }); info(''); }

// Envía la foto a leer y rellena SOLO los campos que sigan vacíos; nunca pisa lo que la persona ya escribió.
function leerTicket(b64) {
  var yo = ++lecturaId; propuestaOcr = null;
  var pre = fotoLista && fotoLista.recortado ? 'Ticket recortado y enderezado. ' : '';
  info(pre + 'Leyendo el ticket…');
  llamar({ accion: 'leer', imagen: b64 }).then(function (r) {
    if (yo !== lecturaId) return;                       // ha cambiado de foto mientras tanto
    if (!r.ok || !r.propuesta) { info(pre + 'No se ha podido leer el ticket de forma automática: rellénalo tú.'); return; }
    var p = r.propuesta, c = p.confianza || {}, puestos = [];
    propuestaOcr = p;
    // Un campo es «libre» si está vacío o si lo rellenó el lector antes y la persona no lo ha tocado (sigue marcado). Lo escrito a mano nunca se pisa.
    var libre = function (id) { var e = $(id); return !e.value.trim() || e.classList.contains('revisar') || e.classList.contains('dudoso'); };
    if (p.comercio && libre('f-concepto')) { $('f-concepto').value = p.comercio; marcar('f-concepto', c.comercio); puestos.push('comercio'); }
    if (p.total && libre('f-importe')) { $('f-importe').value = String(p.total).replace('.', ','); marcar('f-importe', c.total); puestos.push('importe'); }
    if (p.fecha && ($('f-fecha').value === hoy() || libre('f-fecha'))) { $('f-fecha').value = p.fecha; marcar('f-fecha', c.fecha); puestos.push('fecha'); }
    info(pre + (puestos.length ? 'Leído del ticket: revisa ' + puestos.join(', ') + ' antes de guardar. Amarillo = revísalo, rojo = dudoso.'
      : 'No he podido leer el ticket. Rellena los datos a mano: la foto se guarda igualmente.'));
  }).catch(function () { if (yo === lecturaId) info('Sin conexión: no se ha leído el ticket.'); });
}

// Sirve a los dos selectores: la cámara (capture) y «escanear o elegir archivo» (foto o PDF).
var ultimoArchivo = null;
function elegirFoto(ev) {
  var input = ev.target, f = input.files[0];
  input.value = '';   // así se puede volver a elegir el mismo archivo
  if (f) procesarArchivo(f, {});
}

function procesarArchivo(f, opciones) {
  ultimoArchivo = f;
  fotoLista = null; propuestaOcr = null; lecturaId++; info('');
  $('f-miniatura').classList.add('oculto'); $('f-pdf').classList.add('oculto');
  var esPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  $('msg').textContent = esPdf ? 'Preparando el PDF…' : 'Escaneando el ticket…';
  (esPdf ? leerPdf(f) : reducirFoto(f, opciones)).then(function (r) {
    fotoLista = r; $('msg').textContent = '';
    botonesFoto(true);   // ya hay ticket: se quitan las opciones y solo queda «Repetir foto»
    $('btn-sin-recorte').classList.toggle('oculto', !r.recortado);   // si se recortó, se ofrece volver a la foto entera
    if (r.pdf) { $('f-pdf').textContent = 'PDF listo: ' + r.nombre + ' (' + r.kb + ' KB)'; $('f-pdf').classList.remove('oculto'); }
    else { $('f-miniatura').src = r.vista; $('f-miniatura').classList.remove('oculto'); }
    leerTicket(r.ocr);
  }).catch(function (e) { $('msg').textContent = e.message; });
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
  if (!editandoId) idEnCurso = idEnCurso || idNuevo();
  $('guardar').disabled = true;
  var mov = { id: editandoId || idEnCurso, concepto: $('f-concepto').value, fecha: $('f-fecha').value,
    importe_imputado: imp.valor, expresion: imp.expresion, reparto: $('f-reparto').value };
  if (!editandoId && fotoLista) { mov.imagen = fotoLista.b64; if (propuestaOcr) mov.ocr = propuestaOcr; }
  llamar({ accion: editandoId ? 'editar' : 'anadir', mov: mov })
    .then(function (r) {
      if (!r.ok) { $('msg').textContent = 'No se ha guardado: ' + (r.detalle || r.error); return; }
      cerrarFormulario(); pintar(r); mostrarAvisos(r.avisos);
    })
    .catch(function () { $('msg').textContent = 'Sin conexión. Vuelve a pulsar Guardar cuando tengas cobertura; no se duplicará.'; })
    .then(function () { $('guardar').disabled = false; });
}

function hoy() { var d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

document.addEventListener('DOMContentLoaded', function () {
  procesarAlta();
  config = leerConfig();
  // Apuntar un gasto abre directamente la cámara. Solo se puede hacer dentro de este toque (los navegadores no dejan abrirla sin él).
  // Si se cancela, queda el formulario con los dos botones y los campos para rellenar a mano.
  $('nuevo').addEventListener('click', function () {
    editandoId = null; prepararFormulario(false); $('f-fecha').value = hoy(); mostrar('form');
    $('f-camara').click();
  });
  $('btn-camara').addEventListener('click', function () { $('f-camara').click(); });
  $('btn-archivo').addEventListener('click', function () { $('f-foto').click(); });
  $('btn-repetir').addEventListener('click', function () { $('f-camara').click(); });
  $('btn-sin-recorte').addEventListener('click', function () { if (ultimoArchivo) procesarArchivo(ultimoArchivo, { recortar: false }); });
  $('f-camara').addEventListener('change', elegirFoto);
  $('cancelar').addEventListener('click', cerrarFormulario);
  $('ver-anulados').addEventListener('change', function () { if (ultimaRespuesta) pintar(ultimaRespuesta); });
  $('f-foto').addEventListener('change', elegirFoto);
  ['f-concepto', 'f-importe', 'f-fecha'].forEach(function (id) {   // al tocar un campo se da por revisado
    $(id).addEventListener('input', function () { $(id).classList.remove('revisar', 'dudoso'); });
  });
  $('visor-cerrar').addEventListener('click', cerrarVisor);
  $('form').addEventListener('submit', guardar);
  $('form-alta').addEventListener('submit', altaPegada);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  if (config) cargar(); else mostrar('alta');
});
