'use strict';
// Escáner de tickets dentro de la app: encuentra el papel en la foto, lo recorta, lo endereza y aplana la luz.
// Es lo que hace el escáner de documentos del iPhone antes de entregar el archivo, y lo que explica que un PDF
// escaneado se lea bien y una foto suelta no. Sin librerías: geometría pura (probada en Node) + dibujo en canvas.
//
// Límite conocido: asume papel más claro que el fondo y un solo ticket. Con varios tickets pegados recorta el montón
// entero; si no encuentra un rectángulo creíble devuelve null y la app usa la foto completa.

var Escaner = (function () {

  // ---------- Geometría pura ----------

  function suavizar(g, w, h) {   // media 3×3 para que el ruido no rompa el papel en trozos
    var o = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = 0, n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) { var xx = x + dx; if (xx < 0 || xx >= w) continue; s += g[yy * w + xx]; n++; }
        }
        o[y * w + x] = (s / n) | 0;
      }
    }
    return o;
  }

  function umbralOtsu(g) {   // el nivel que mejor separa «papel claro» de «fondo oscuro»
    var hist = new Uint32Array(256), i;
    for (i = 0; i < g.length; i++) hist[g[i]]++;
    var total = g.length, suma = 0;
    for (i = 0; i < 256; i++) suma += i * hist[i];
    var sumaB = 0, wB = 0, mejor = 0, t = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = total - wB; if (!wF) break;
      sumaB += i * hist[i];
      var mB = sumaB / wB, mF = (suma - sumaB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > mejor) { mejor = v; t = i; }
    }
    return t;
  }

  function casco(pts) {   // envolvente convexa (Andrew)
    pts = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var cruz = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
    var i, baja = [], alta = [];
    for (i = 0; i < pts.length; i++) { while (baja.length >= 2 && cruz(baja[baja.length - 2], baja[baja.length - 1], pts[i]) <= 0) baja.pop(); baja.push(pts[i]); }
    for (i = pts.length - 1; i >= 0; i--) { while (alta.length >= 2 && cruz(alta[alta.length - 2], alta[alta.length - 1], pts[i]) <= 0) alta.pop(); alta.push(pts[i]); }
    alta.pop(); baja.pop();
    return baja.concat(alta);
  }

  // Rectángulo de área mínima que contiene la envolvente. Devuelve el centro, los ejes unitarios (u = ancho, v = largo,
  // v apunta hacia abajo) y las medidas. El lado largo queda vertical: es como se lee un ticket.
  function rectMinimo(h) {
    var mejor = null, n = h.length, i, j;
    for (i = 0; i < n; i++) {
      var a = h[i], b = h[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.sqrt(ex * ex + ey * ey);
      if (l < 1e-9) continue;
      ex /= l; ey /= l;
      var nx = -ey, ny = ex, minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
      for (j = 0; j < n; j++) {
        var e = h[j][0] * ex + h[j][1] * ey, q = h[j][0] * nx + h[j][1] * ny;
        if (e < minE) minE = e; if (e > maxE) maxE = e; if (q < minN) minN = q; if (q > maxN) maxN = q;
      }
      var area = (maxE - minE) * (maxN - minN);
      if (!mejor || area < mejor.area) mejor = { area: area, ex: ex, ey: ey, nx: nx, ny: ny, minE: minE, maxE: maxE, minN: minN, maxN: maxN };
    }
    if (!mejor) return null;
    var extE = mejor.maxE - mejor.minE, extN = mejor.maxN - mejor.minN;
    var ce = (mejor.minE + mejor.maxE) / 2, cn = (mejor.minN + mejor.maxN) / 2;
    var cx = ce * mejor.ex + cn * mejor.nx, cy = ce * mejor.ey + cn * mejor.ny;
    var ux, uy, vx, vy, ancho, alto;
    if (extN >= extE) { ux = mejor.ex; uy = mejor.ey; vx = mejor.nx; vy = mejor.ny; ancho = extE; alto = extN; }
    else { vx = mejor.ex; vy = mejor.ey; ux = vy; uy = -vx; ancho = extN; alto = extE; }   // v = (−uy, ux): sin espejo
    if (vy < 0) { ux = -ux; uy = -uy; vx = -vx; vy = -vy; }                                   // el lado largo apunta hacia abajo
    return { cx: cx, cy: cy, ux: ux, uy: uy, vx: vx, vy: vy, ancho: ancho, alto: alto };
  }

  // g: grises (Uint8Array w×h). Devuelve el rectángulo del papel o null si no hay uno creíble.
  function detectar(g, w, h) {
    var s = suavizar(g, w, h), t = umbralOtsu(s), N = w * h, i, mask = new Uint8Array(N), sumC = 0, nC = 0, sumO = 0, nO = 0;
    for (i = 0; i < N; i++) { if (s[i] > t) { mask[i] = 1; sumC += s[i]; nC++; } else { sumO += s[i]; nO++; } }
    // el papel tiene que distinguirse del fondo: sobre una mesa casi blanca el umbral separaría ruido y recortaría a ciegas
    if (!nC || !nO || sumC / nC - sumO / nO < 35) return null;

    // componentes conexas (4 vecinos) y su tamaño
    var etiqueta = new Int32Array(N), pila = new Int32Array(N), tam = [0], n = 0;
    for (i = 0; i < N; i++) {
      if (!mask[i] || etiqueta[i]) continue;
      n++; var sp = 0, area = 0; pila[sp++] = i; etiqueta[i] = n;
      while (sp) {
        var p = pila[--sp], x = p % w, y = (p - x) / w; area++;
        if (x > 0 && mask[p - 1] && !etiqueta[p - 1]) { etiqueta[p - 1] = n; pila[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !etiqueta[p + 1]) { etiqueta[p + 1] = n; pila[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !etiqueta[p - w]) { etiqueta[p - w] = n; pila[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !etiqueta[p + w]) { etiqueta[p + w] = n; pila[sp++] = p + w; }
      }
      tam.push(area);
    }
    var mayor = 0, k;
    for (k = 1; k <= n; k++) if (!mayor || tam[k] > tam[mayor]) mayor = k;
    if (!mayor) return null;
    var frac = tam[mayor] / N;
    if (frac < 0.08 || frac > 0.92) return null;                // demasiado pequeño, o es toda la imagen (no hay fondo que quitar)

    // extremos por fila de esa componente → envolvente → rectángulo mínimo
    var pts = [], y2, x2;
    for (y2 = 0; y2 < h; y2++) {
      var lo = -1, hi = -1;
      for (x2 = 0; x2 < w; x2++) if (etiqueta[y2 * w + x2] === mayor) { if (lo < 0) lo = x2; hi = x2; }
      if (lo >= 0) { pts.push([lo, y2], [hi + 1, y2], [lo, y2 + 1], [hi + 1, y2 + 1]); }
    }
    var r = rectMinimo(casco(pts));
    if (!r) return null;
    var rel = tam[mayor] / (r.ancho * r.alto);
    var aspecto = r.alto / Math.max(r.ancho, 1e-9);
    if (rel < 0.70) return null;                                // no es un rectángulo: no se recorta a ciegas
    if (aspecto < 1.15 || aspecto > 15) return null;            // casi cuadrado o una tira: no es un ticket
    r.fraccion = frac; r.relleno = rel;
    return r;
  }

  // ---------- Dibujo en el móvil (necesita canvas) ----------

  function lienzo(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }

  // Busca el ticket en la foto; devuelve el rectángulo en píxeles de la foto original, o null.
  function detectarEnImagen(img) {
    var k = Math.min(1, 480 / Math.max(img.width, img.height)), w = Math.round(img.width * k), h = Math.round(img.height * k);
    var c = lienzo(w, h), g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h).data, gris = new Uint8Array(w * h);
    for (var i = 0, j = 0; i < d.length; i += 4, j++) gris[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    var r = detectar(gris, w, h);
    if (!r) return null;
    r.cx /= k; r.cy /= k; r.ancho /= k; r.alto /= k;            // de nuevo a píxeles de la foto original
    return r;
  }

  // Recorta y endereza el rectángulo desde la foto original (con un pequeño margen), con el lado largo como máximo.
  function recortar(img, r, ladoMax) {
    var ancho = r.ancho * 1.04, alto = r.alto * 1.02, s = Math.min(1, ladoMax / Math.max(ancho, alto));
    var c = lienzo(Math.round(ancho * s), Math.round(alto * s)), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    // destino = s · [u v]ᵀ · (origen − centro) + centro del lienzo
    g.setTransform(s * r.ux, s * r.vx, s * r.uy, s * r.vy,
      c.width / 2 - s * (r.ux * r.cx + r.uy * r.cy), c.height / 2 - s * (r.vx * r.cx + r.vy * r.cy));
    g.drawImage(img, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  // Aplana la iluminación: divide cada punto por la luz de su entorno (sombras y degradados desaparecen) y deja grises.
  function aplanarLuz(canvas) {
    var w = canvas.width, h = canvas.height, c = lienzo(w, h), g = c.getContext('2d');
    g.drawImage(canvas, 0, 0);
    var datos = g.getImageData(0, 0, w, h), p = datos.data;
    var peq = canvas;                                           // luz de fondo: se reduce a la mitad varias veces (promedia) y se vuelve a ampliar
    while (peq.width > w / 24 && peq.width > 16) { var m = lienzo(Math.round(peq.width / 2), Math.round(peq.height / 2)); m.getContext('2d').drawImage(peq, 0, 0, m.width, m.height); peq = m; }
    var gb = lienzo(w, h).getContext('2d'); gb.imageSmoothingEnabled = true; gb.imageSmoothingQuality = 'high'; gb.drawImage(peq, 0, 0, w, h);
    var f = gb.getImageData(0, 0, w, h).data;
    for (var i = 0; i < p.length; i += 4) {
      var y = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000, luz = (f[i] * 299 + f[i + 1] * 587 + f[i + 2] * 114) / 1000;
      var v = luz > 12 ? Math.min(255, y / luz * 235) : y;
      p[i] = p[i + 1] = p[i + 2] = v | 0;
    }
    g.putImageData(datos, 0, 0);
    return c;
  }

  return { suavizar: suavizar, umbralOtsu: umbralOtsu, casco: casco, rectMinimo: rectMinimo, detectar: detectar,
    detectarEnImagen: detectarEnImagen, recortar: recortar, aplanarLuz: aplanarLuz };
})();

if (typeof module !== 'undefined') module.exports = Escaner;
