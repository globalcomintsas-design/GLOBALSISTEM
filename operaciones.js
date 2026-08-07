import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, setDoc, onSnapshot, orderBy, query, updateDoc, where }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDO5AtG0PZ_Y48MGwmeDPktxTQfvcj9dbc",
  authDomain: "caja-globalcomint.firebaseapp.com",
  projectId: "caja-globalcomint",
  storageBucket: "caja-globalcomint.firebasestorage.app",
  messagingSenderId: "191266145805",
  appId: "1:191266145805:web:a4b7e7124e6ad9f8f9b744"
};
const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ── Auth check ──
const sesion = localStorage.getItem('gc_user');
if(!sesion){ location.href='index.html'; }
const user = JSON.parse(sesion);
document.getElementById('userChip').textContent = '👤 ' + user.nombre;

// ── Estado global ──
let operaciones = [];
let clientes = [];
let mudanzas = [];
let pagos = [];
let despachantesNombres = [];
let clientesNombres = [];
let clientesFinalesDocs = []; // [{id, nombre}] de corresponsales_clientes_finales
window.despachantesNombres = despachantesNombres;
window.clientesNombres = clientesNombres;

// Variables de estado del formulario (accesibles en todo el módulo)
let tieneFactura = true;
let esApoderado  = false;
let esKotinya    = false;
let opEditandoId = null;
let datosCargados = false;

// Paginación del listado
let listadoPage = 1;
const LISTADO_PAGE_SIZE = 15;

// ── Paginación genérica (para tablas que no tenían paginación propia) ──
// Se usa para: Historial de pagos, Vinculaciones automáticas (Saldos), Cuenta Ramiro,
// Historial de recibos y las tablas de Clientes/Clientes finales. Cada tabla se identifica
// por una "key" propia y mantiene su propio número de página en paginaGenerica.
const PAGE_SIZE_GENERICO = 15;
const paginaGenerica = {}; // { key: numeroDePagina }

function getPaginaGenerica(key){ return paginaGenerica[key] || 1; }

function paginarArray(key, arr, pageSize){
  const totalPaginas = Math.max(1, Math.ceil(arr.length / pageSize));
  let page = getPaginaGenerica(key);
  if(page > totalPaginas) page = totalPaginas;
  if(page < 1) page = 1;
  paginaGenerica[key] = page;
  const inicio = (page - 1) * pageSize;
  return { pagina: arr.slice(inicio, inicio + pageSize), page, totalPaginas };
}

function htmlPaginacionGenerica(page, totalPaginas, key){
  return `<div class="pagin-bar">
      <button onclick="cambiarPaginaGenerica('${key}',-1)" ${page<=1?'disabled':''}>‹ Anterior</button>
      <span>${page}/${totalPaginas}</span>
      <button onclick="cambiarPaginaGenerica('${key}',1)" ${page>=totalPaginas?'disabled':''}>Siguiente ›</button>
    </div>`;
}

window.cambiarPaginaGenerica = function(key, delta){
  paginaGenerica[key] = Math.max(1, getPaginaGenerica(key) + delta);
  switch(key){
    case 'pagos':           renderSaldos(); break;
    case 'vinculaciones':   renderLogVinculaciones(); break;
    case 'ramiro':          renderRamiro(); break;
    case 'remitosHist':     renderHistorialRemitos(); break;
    case 'clientesDesp':    renderTablaClientes(); break;
    case 'clientesFinales': renderTablaClientesFinales(); break;
  }
};

// Para que el selector de mes del Dashboard arranque en el mes en curso (no en blanco)
// y no quede pegado a un mes viejo por una carga inicial incompleta de Firestore.
let usuarioEligioMesDash = false;
window.marcarMesDashElegidoPorUsuario = function(){ usuarioEligioMesDash = true; };

// Igual que el de arriba pero para el filtro de mes del Listado: arranca siempre en el
// mes en curso, y una vez que el usuario lo cambia a mano (incluido "Todos los meses"),
// se respeta esa elección y no se lo pisa más.
let usuarioEligioMesListado = false;
window.marcarMesListadoElegidoPorUsuario = function(){ usuarioEligioMesListado = true; };

// ── UTILS ──
function fmt(n){ return Math.round(n||0).toLocaleString('es-AR'); }
window.fmt = fmt;

// Formato exacto (2 decimales, sin redondear a entero) - se usa en Pagos/Saldos y Dashboard
function fmt2(n){
  return (n||0).toLocaleString('es-AR', { minimumFractionDigits:2, maximumFractionDigits:2 });
}
window.fmt2 = fmt2;

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}
window.toast = toast;

// Etiqueta legible para el tipo de tarifa de un despachante
function etiquetaTipoDespachante(tipo){
  switch(tipo){
    case 'desp_externo': return { txt:'Externo ⭐', style:'background:#fef3c7;color:#92400e' };
    case 'apoderado':    return { txt:'Apoderado',  style:'background:#ede9fe;color:#5b21b6' };
    case 'kotinya':      return { txt:'Kotinya/Ramiro', style:'background:#fef9c3;color:#92400e' };
    default:             return { txt:'Despachante', style:'' };
  }
}
window.etiquetaTipoDespachante = etiquetaTipoDespachante;

// Estado de residencia (para color del Cliente final y de la columna Residencia en Mudanzas)
// - Sin fecha de vencimiento cargada -> verde (no aplica / no tiene residencia temporal)
// - Cancelada/renovada -> verde
// - Falta más de 30 días -> amarillo
// - Falta 30 días o menos (o ya vencida) -> rojo
function estadoResidencia(m){
  if(!m || !m.vencimientoResidencia){
    return { clase:'ok', label:'N/A', bg:'#dcfce7', color:'#166534' };
  }
  if(m.residenciaCancelada){
    return { clase:'ok', label:'Cancelada', bg:'#dcfce7', color:'#166534' };
  }
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const venc = new Date(m.vencimientoResidencia + 'T00:00:00');
  const diffDias = Math.ceil((venc - hoy) / (1000*60*60*24));
  if(diffDias > 30){
    return { clase:'warn', label:`Vence en ${diffDias}d`, bg:'#fef9c3', color:'#854d0e' };
  }
  if(diffDias >= 0){
    return { clase:'danger', label:`Vence en ${diffDias}d`, bg:'#fee2e2', color:'#991b1b' };
  }
  return { clase:'danger', label:'Vencida', bg:'#fee2e2', color:'#991b1b' };
}
window.estadoResidencia = estadoResidencia;

// ── TOGGLE TARIFAS ──
window.toggleTarifas = function(){
  const body = document.getElementById('tarifas-body');
  const icon = document.getElementById('tarifas-toggle-icon');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  icon.textContent = open ? '🔓' : '🔒';
};

// ── SWITCH TAB ──
window.switchTab = function(tab){
  ['cargar','listado','dashboard','saldos','clientes','mudanzas','ramiro','remitos'].forEach(t => {
    document.getElementById('tab-'+t).style.display = t===tab ? 'block' : 'none';
  });
  document.querySelectorAll('.tab').forEach((btn,i) => {
    btn.classList.toggle('active', ['cargar','listado','dashboard','saldos','clientes','mudanzas','ramiro','remitos'][i]===tab);
  });
  if(tab==='listado')   renderTabla();
  if(tab==='dashboard') renderDashboard();
  if(tab==='saldos'){ renderSaldos(); renderLogVinculaciones(); }
  if(tab==='clientes')  renderTablaClientesFinales();
  if(tab==='ramiro')    renderRamiro();
  if(tab==='remitos')   renderRemitos();
};

// ── AUTOCOMPLETE ──
let acState = {}; // { [listId]: { items:[{tipo:'match'|'nuevo', valor}], activeIndex, inputId, esDespachante } }

function renderAC(listId){
  const state = acState[listId];
  const list = document.getElementById(listId);
  if(!list) return;
  if(!state || !state.items.length){ list.style.display='none'; return; }
  list.innerHTML = state.items.map((it,i) => {
    const activeClass = i === state.activeIndex ? ' ac-item-active' : '';
    if(it.tipo === 'nuevo'){
      return `<div class="ac-item ac-new${activeClass}" onmousedown="seleccionarACIndex('${listId}',${i})">➕ Guardar "${it.valor}"</div>`;
    }
    return `<div class="ac-item${activeClass}" onmousedown="seleccionarACIndex('${listId}',${i})">${it.valor}</div>`;
  }).join('');
  list.style.display = 'block';
  const activeEl = list.querySelector('.ac-item-active');
  if(activeEl) activeEl.scrollIntoView({block:'nearest'});
}
window.renderAC = renderAC;

window.filtrarAC = function(inputId, listId, fuente, esDespachante){
  const val = document.getElementById(inputId).value.trim().toUpperCase();
  const list = document.getElementById(listId);
  if(!val){ list.style.display='none'; acState[listId] = null; return; }
  const matches = fuente.filter(n => n.toUpperCase().includes(val)).slice(0,8);
  const existe  = fuente.map(n=>n.toUpperCase()).includes(val);
  const items = matches.map(n => ({tipo:'match', valor:n}));
  if(!existe && val.length > 1){
    items.push({tipo:'nuevo', valor: val});
  }
  acState[listId] = { items, activeIndex: -1, inputId, esDespachante };
  renderAC(listId);
};

window.seleccionarACIndex = function(listId, idx){
  const state = acState[listId];
  if(!state) return;
  const it = state.items[idx];
  if(!it) return;
  if(it.tipo === 'nuevo'){
    guardarNuevoAC(state.inputId, listId, state.esDespachante);
  } else {
    document.getElementById(state.inputId).value = it.valor;
    document.getElementById(listId).style.display = 'none';
    acState[listId] = null;
    if(state.esDespachante) onCambiarDespachante();
    else recalcularFormulario();
  }
};

window.manejarTecladoAC = function(e, listId){
  const state = acState[listId];
  const list = document.getElementById(listId);
  if(!state || !list || list.style.display === 'none' || !state.items.length) return;
  if(e.key === 'ArrowDown'){
    e.preventDefault();
    state.activeIndex = state.activeIndex < state.items.length - 1 ? state.activeIndex + 1 : 0;
    renderAC(listId);
  } else if(e.key === 'ArrowUp'){
    e.preventDefault();
    state.activeIndex = state.activeIndex > 0 ? state.activeIndex - 1 : state.items.length - 1;
    renderAC(listId);
  } else if(e.key === 'Enter' || e.key === 'Tab'){
    if(state.activeIndex >= 0){
      e.preventDefault();
      seleccionarACIndex(listId, state.activeIndex);
    }
  } else if(e.key === 'Escape'){
    list.style.display = 'none';
  }
};

window.cerrarAC = function(listId){
  const el = document.getElementById(listId);
  if(el) el.style.display = 'none';
};

window.guardarNuevoAC = async function(inputId, listId, esDespachante){
  const val = document.getElementById(inputId).value.trim().toUpperCase();
  if(!val) return;
  document.getElementById(listId).style.display = 'none';
  acState[listId] = null;
  if(esDespachante){
    const id = val.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
    await setDoc(doc(db,'corresponsales_clientes',id), {
      nombre: val, tipo:'despachante', factura:'mensual', tieneFactura:'si', cuit:''
    });
    toast('✅ Despachante guardado: ' + val);
  } else {
    const id = val.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
    await setDoc(doc(db,'corresponsales_clientes_finales',id), {nombre:val});
    clientesNombres = [...new Set([...clientesNombres, val])].sort();
    window.clientesNombres = clientesNombres;
    toast('✅ Cliente guardado: ' + val);
  }
};

// ── Fecha default ──
document.getElementById('op_fecha').value    = new Date().toISOString().split('T')[0];
document.getElementById('mud_fecha').value   = new Date().toISOString().split('T')[0];

// Auto fin de semana según fecha
document.getElementById('op_fecha').addEventListener('change', function(){
  const d = new Date(this.value + 'T12:00:00');
  const esFinsem = d.getDay() === 0 || d.getDay() === 6;
  document.getElementById('chk_finsem').checked = esFinsem;
  recalcularFormulario();
});

// ── NÚMERO DE OP ──
function generarNumOp(){
  return operaciones.length + 1;
}

// ── FIRESTORE listeners ──
// Ops: tiempo real pero solo año en curso (fecha es string YYYY-MM-DD)
const _anioActual = new Date().getFullYear();
const _fechaDesde = _anioActual + '-01-01';

onSnapshot(query(collection(db,'despachantees_ops'), where('fecha','>=',_fechaDesde), orderBy('fecha','asc')), snap => {
  operaciones = snap.docs.map(d => ({id:d.id, ...d.data()}));
  datosCargados = true;
  renderFiltros();
  // re-render tab activo si corresponde
  const tabActivo = document.querySelector('.tab.active')?.textContent || '';
  if(tabActivo.includes('Listado'))   renderTabla();
  if(tabActivo.includes('Dashboard')) renderDashboard();
  if(tabActivo.includes('Saldos'))    renderSaldos();
  if(tabActivo.includes('Ramiro'))    renderRamiro();
  if(tabActivo.includes('Clientes'))  renderTablaClientesFinales();
  recalcularFormulario();
});

// Pagos a despachantes: colección chica, sin filtro de año
onSnapshot(collection(db,'despachantees_pagos'), snap => {
  pagos = snap.docs.map(d => ({id:d.id, ...d.data()}));
  window.pagos = pagos;
  renderSaldos();
});

// ── Log de vinculaciones automáticas desde Caja ──
// Se alimenta desde caja.html (colección 'log_vinculaciones_caja') cada vez que se carga
// un Ingreso y el sistema intenta vincularlo con Operaciones (pago por factura, pago
// genérico por despachante, o marcar una mudanza como cobrada). Se muestra en la
// pestaña Saldos, junto al historial de pagos, para poder auditar qué hizo el sistema.
let logVinculaciones = [];
onSnapshot(query(collection(db,'log_vinculaciones_caja'), orderBy('ts','desc')), snap => {
  logVinculaciones = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderLogVinculaciones();
});

function renderLogVinculaciones(){
  const tbody = document.getElementById('tbody-log-vinculaciones');
  const paginacionEl = document.getElementById('vinculaciones-paginacion');
  if(!tbody) return;
  if(!logVinculaciones.length){
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:16px;">Sin registros</td></tr>';
    if(paginacionEl) paginacionEl.innerHTML = '';
    return;
  }
  // logVinculaciones ya viene ordenado del más nuevo al más viejo (orderBy ts desc)
  const { pagina, page, totalPaginas } = paginarArray('vinculaciones', logVinculaciones, PAGE_SIZE_GENERICO);
  tbody.innerHTML = pagina.map(l => {
    const huboAlerta = (l.acciones||[]).some(a => a.startsWith('⚠️'));
    const accionesHtml = (l.acciones||[]).map(a =>
      a.startsWith('⚠️')
        ? `<div style="color:#dc2626;font-weight:600;">${a}</div>`
        : `<div style="color:#059669;">${a}</div>`
    ).join('');
    return `<tr style="${huboAlerta ? 'background:#fef2f2;' : ''}">
      <td>${l.fecha||''}</td>
      <td><strong>${l.cliente||''}</strong></td>
      <td class="mono">${l.factura||'-'}</td>
      <td style="text-align:right;font-weight:600;">$${fmt2(l.importe)}</td>
      <td style="font-size:11px;max-width:340px;">${accionesHtml}</td>
      <td style="font-size:11px;color:#64748b;">${l.cargadoPor||''}</td>
    </tr>`;
  }).join('');
  if(paginacionEl) paginacionEl.innerHTML = htmlPaginacionGenerica(page, totalPaginas, 'vinculaciones');
}
window.renderLogVinculaciones = renderLogVinculaciones;

// Clientes: colección chica y estática, sin filtro
onSnapshot(collection(db,'corresponsales_clientes'), snap => {
  clientes = snap.docs.map(d => ({id:d.id, ...d.data()}));
  despachantesNombres = clientes.map(c => c.nombre).sort();
  window.despachantesNombres = despachantesNombres;
  renderTablaClientes();
  renderFiltros();
  renderSaldos();
});

onSnapshot(collection(db,'corresponsales_clientes_finales'), snap => {
  clientesFinalesDocs = snap.docs.map(d => ({id:d.id, nombre:d.data().nombre})).filter(c => c.nombre);
  const fromDB = clientesFinalesDocs.map(c => c.nombre);
  const fromOps = [...new Set(operaciones.map(o => o.cliente).filter(Boolean))];
  clientesNombres = [...new Set([...fromDB, ...fromOps])].sort();
  window.clientesNombres = clientesNombres;
  renderTablaClientesFinales();
});

// Mudanzas: tiempo real, solo año en curso
onSnapshot(query(collection(db,'corresponsales_mudanzas'), where('fecha','>=',_fechaDesde), orderBy('fecha','asc')), snap => {
  mudanzas = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderMudanzas();
  const tabActivo = document.querySelector('.tab.active')?.textContent || '';
  if(tabActivo.includes('Ramiro'))   renderRamiro();
  if(tabActivo.includes('Clientes')) renderTablaClientesFinales();
});

// ── CAMBIO TIPO DESPACHO (select global) ──
window.onTipoDespachoChange = function(){
  const tipo = document.getElementById('tipo_desp_global').value;
  esApoderado = tipo === 'apoderado';
  esKotinya   = tipo === 'kotinya';

  const badge = document.getElementById('premium-badge');
  const tApod = parseFloat(document.getElementById('t_apoderado').value) || 100;
  const tKot  = parseFloat(document.getElementById('t_kotinya').value) || 85;
  const tRam  = parseFloat(document.getElementById('t_ramiro_op').value) || 30;

  if(['desp_externo','apoderado','kotinya'].includes(tipo)){
    badge.style.display = 'inline-block';
    if(tipo === 'apoderado')    badge.textContent = `APODERADO USD ${tApod}`;
    else if(tipo === 'kotinya') badge.textContent = `KOTINYA USD ${tKot} · PAGO RAMIRO USD ${tRam}`;
    else                        badge.textContent = '+20% PREMIUM';
  } else {
    badge.style.display = 'none';
  }

  // Ocultar/mostrar canal según tipo
  const tipoOpActual = document.getElementById('op_tipo').value;
  const esMICoMultinota = tipoOpActual === 'MIC' || tipoOpActual === 'MULTINOTA' || tipoOpActual === 'ADICIONALES';
  const canalGroup = document.getElementById('op_canal').closest('.form-group');
  const sinCanal = esApoderado || esKotinya || esMICoMultinota;
  canalGroup.style.opacity = sinCanal ? '0.4' : '';
  canalGroup.style.pointerEvents = sinCanal ? 'none' : '';

  recalcularFormulario();
};

// ── CAMBIO TIPO OPERACIÓN ──
window.onTipoChange = function(){
  const tipoOp  = document.getElementById('op_tipo').value;
  const esMIC       = tipoOp === 'MIC';
  const esMultinota = tipoOp === 'MULTINOTA';
  const esAdicionales = tipoOp === 'ADICIONALES';

  if(esMIC){
    document.getElementById('chk_mic').checked = true;
  } else {
    document.getElementById('chk_mic').checked = false;
  }

  const destinGroup = document.getElementById('destinacion-group');
  const canalGroup  = document.getElementById('op_canal').closest('.form-group');

  // Tipo "Adicionales": no tiene destinación ni canal, se ocultan por completo
  destinGroup.style.display = esAdicionales ? 'none' : '';

  if(esMIC || esMultinota || esAdicionales){
    canalGroup.style.display = esAdicionales ? 'none' : '';
    canalGroup.style.opacity = '0.3';
    canalGroup.style.pointerEvents = 'none';
    document.getElementById('chk-sobre-wrap').style.display = 'none';
    document.getElementById('chk-cam-wrap').style.display = 'none';
    document.getElementById('chk-senasa-p-wrap').style.display = 'none';
    document.getElementById('chk-senasa-prod-wrap').style.display = 'none';
  } else {
    const sinCanal = esApoderado || esKotinya;
    canalGroup.style.display = '';
    canalGroup.style.opacity = sinCanal ? '0.4' : '';
    canalGroup.style.pointerEvents = sinCanal ? 'none' : '';
    document.getElementById('chk-sobre-wrap').style.display = '';
    document.getElementById('chk-cam-wrap').style.display = '';
    document.getElementById('chk-senasa-p-wrap').style.display = '';
    document.getElementById('chk-senasa-prod-wrap').style.display = '';
  }
  recalcularFormulario();
};

// ── CAMBIO DESPACHANTE ──
window.onCambiarDespachante = function(){
  const nombre = document.getElementById('op_despachante').value.trim().toUpperCase();

  // Auto-detectar Kotinya por nombre
  if(nombre.includes('KOTINYA')){
    document.getElementById('tipo_desp_global').value = 'kotinya';
    esKotinya   = true;
    esApoderado = false;
    tieneFactura = true;
    onTipoDespachoChange();
    return;
  }

  const cli = clientes.find(c => c.nombre === nombre);
  const tiposValidos = ['desp_externo','apoderado','kotinya'];
  if(cli){
    document.getElementById('tipo_desp_global').value = tiposValidos.includes(cli.tipo) ? cli.tipo : 'despachante';
    document.getElementById('op_periodo_factura').value = cli.factura || 'mensual';
    tieneFactura = cli.tieneFactura !== 'no';
  } else {
    document.getElementById('tipo_desp_global').value = 'despachante';
    tieneFactura = true;
  }

  const tipoSel = document.getElementById('tipo_desp_global').value;
  esKotinya   = tipoSel === 'kotinya';
  esApoderado = tipoSel === 'apoderado';
  onTipoDespachoChange();
};

// ── CÁLCULO ──
function getTarifas(){
  const canal       = document.getElementById('op_canal').value;
  const tipo        = document.getElementById('tipo_desp_global').value;
  const tipoOp      = document.getElementById('op_tipo').value;
  const esMIC       = tipoOp === 'MIC';
  const esMultinota = tipoOp === 'MULTINOTA';
  const esAdicionales = tipoOp === 'ADICIONALES';
  const esPremium   = tipo === 'desp_externo';
  const _esApoderado = tipo === 'apoderado';
  const _esKotinya   = tipo === 'kotinya';
  const tcInput = document.getElementById('op_tc').value;
  const tcFalta = tcInput === '' || isNaN(parseFloat(tcInput)) || parseFloat(tcInput) <= 0;
  const tc = tcFalta ? 0 : parseFloat(tcInput);

  const items = [];
  const usd   = (u, label) => { items.push({label, usd: u, pesos: u * tc}); };
  const pesos = (p, label) => { items.push({label, usd: 0, pesos: p}); };

  // ── Honorarios base ──
  if(_esApoderado){
    usd(parseFloat(document.getElementById('t_apoderado').value) || 100, 'Apoderado');
  } else if(_esKotinya){
    usd(parseFloat(document.getElementById('t_kotinya').value) || 85, 'Kotinya');
  } else if(esMultinota){
    usd(parseFloat(document.getElementById('t_multinota').value) || 2, 'Multinota');
  } else if(!esMIC && !esAdicionales){
    let hon_usd;
    if(esPremium){
      hon_usd = canal === 'R'
        ? parseFloat(document.getElementById('t_prem_r').value)
        : parseFloat(document.getElementById('t_prem_vn').value);
    } else {
      hon_usd = canal === 'R'
        ? parseFloat(document.getElementById('t_r').value)
        : parseFloat(document.getElementById('t_vn').value);
    }
    usd(hon_usd, `Honorarios canal ${canal}`);
  }

  if(!esMultinota && !esAdicionales && document.getElementById('chk_sobre').checked)
    usd(parseFloat(document.getElementById('t_sobre').value), 'Armado sobre');

  if(!esMultinota && !esAdicionales && document.getElementById('chk_cam').checked){
    const n = parseInt(document.getElementById('n_cam').value)||1;
    let t;
    if(_esApoderado){
      t = parseFloat(document.getElementById('t_cam_apod').value);
    } else if(esPremium){
      t = canal === 'R'
        ? parseFloat(document.getElementById('t_prem_cam_r').value)
        : parseFloat(document.getElementById('t_prem_cam_vn').value);
    } else {
      t = canal === 'R'
        ? parseFloat(document.getElementById('t_cam_r').value)
        : parseFloat(document.getElementById('t_cam_vn').value);
    }
    usd(t*n, `Camión AD ×${n}`);
  }

  if(!esMultinota && !esAdicionales && document.getElementById('chk_senasa_p').checked){
    const n = parseInt(document.getElementById('n_senasa_p').value)||1;
    usd(parseFloat(document.getElementById('t_senasa_p').value)*n, `SENASA embalaje ×${n}`);
  }

  if(!esMultinota && !esAdicionales && document.getElementById('chk_senasa_prod').checked)
    usd(parseFloat(document.getElementById('t_senasa_prod').value), 'SENASA producto');

  if(document.getElementById('chk_hojas').checked){
    const n = parseInt(document.getElementById('n_hojas').value)||1;
    usd(parseFloat(document.getElementById('t_hoja').value)*n, `Hojas adicionales ×${n}`);
  }

  if(document.getElementById('chk_mic').checked)
    usd(parseFloat(document.getElementById('t_mic').value), 'MIC base');

  if(document.getElementById('chk_mic_fojas').checked){
    const n = parseInt(document.getElementById('n_mic_fojas').value)||1;
    usd(parseFloat(document.getElementById('t_mic_foja').value)*n, `Fojas adicionales MIC ×${n}`);
  }

  if(document.getElementById('chk_finsem').checked)
    usd(parseFloat(document.getElementById('t_finsem').value), 'Fin de semana');

  if(document.getElementById('chk_mov_ad').checked){
    const movVal = parseFloat(document.getElementById('t_mov_ad').value) || 0;
    if(movVal > 0) usd(movVal, 'MOV AD');
  }

  // Adicionales en pesos
  const adicPesos = parseFloat(document.getElementById('op_adicionales_pesos').value)||0;
  if(adicPesos > 0) pesos(adicPesos, 'Adicionales en pesos');

  // Adicionales en USD
  const adicUsd = parseFloat(document.getElementById('op_adicionales_usd').value)||0;
  if(adicUsd > 0) usd(adicUsd, 'Adicionales en USD');

  const totalNeto = items.reduce((a,b) => a + b.pesos, 0);
  const iva       = tieneFactura ? totalNeto * 0.21 : 0;
  const bruto     = totalNeto + iva;
  const totalUsd  = items.reduce((a,b) => a + b.usd, 0);

  return { items, totalNeto, iva, bruto, tc, totalUsd, esMIC, esMultinota, esAdicionales, tcFalta };
}

window.recalcularFormulario = function(){
  try {
    const { items, totalNeto, iva, bruto, tcFalta } = getTarifas();
    const tcInputEl = document.getElementById('op_tc');

    if(tcFalta){
      tcInputEl.style.borderColor = '#dc2626';
      tcInputEl.style.background  = '#fef2f2';
      document.getElementById('prev_neto').textContent  = '⚠️ Falta TC';
      document.getElementById('prev_iva').textContent   = '⚠️ Falta TC';
      document.getElementById('prev_bruto').textContent = '⚠️ Falta TC';
      document.getElementById('prev_neto').style.color  = '#dc2626';
      document.getElementById('prev_bruto').style.color = '#dc2626';
      document.getElementById('prev_iva').style.color   = '#dc2626';
      document.getElementById('desglose-prev').innerHTML = '<span style="color:#dc2626;font-weight:700;">⚠️ Ingresá el Tipo de Cambio (TC) para calcular la liquidación. No se puede guardar sin este dato.</span>';
      document.getElementById('op-numero-preview').textContent = '→ Op #' + generarNumOp();
      return;
    }

    tcInputEl.style.borderColor = '';
    tcInputEl.style.background  = '';

    document.getElementById('prev_neto').textContent  = '$ ' + fmt(totalNeto);
    document.getElementById('prev_iva').textContent   = tieneFactura ? '$ ' + fmt(iva) : '— Sin factura';
    document.getElementById('prev_bruto').textContent = '$ ' + fmt(bruto);
    document.getElementById('prev_neto').style.color  = '';
    document.getElementById('prev_bruto').style.color = '';
    document.getElementById('prev_iva').style.color   = tieneFactura ? '' : '#dc2626';

    const desglose = items.map(i =>
      `<span class="tag">${i.label}: ${i.usd > 0 ? 'USD '+i.usd.toFixed(2)+' → ' : ''}$${fmt(i.pesos)}</span>`
    ).join(' ');
    document.getElementById('desglose-prev').innerHTML = desglose;
    document.getElementById('op-numero-preview').textContent = '→ Op #' + generarNumOp();
  } catch(e) {
    console.warn('recalcularFormulario error:', e);
  }
};

// ── CONSTRUIR DATOS DEL FORMULARIO (compartido entre crear y actualizar) ──
function construirDatosOperacion(){
  const { items, totalNeto, iva, bruto, tc, totalUsd, esMIC, esMultinota, esAdicionales } = getTarifas();
  const tipo = document.getElementById('tipo_desp_global').value;

  const adicTags = [];
  if(!esMultinota && !esAdicionales && document.getElementById('chk_sobre').checked)      adicTags.push('Armado');
  if(!esMultinota && !esAdicionales && document.getElementById('chk_cam').checked)        adicTags.push(`Cam×${document.getElementById('n_cam').value}`);
  if(!esMultinota && !esAdicionales && document.getElementById('chk_senasa_p').checked)   adicTags.push(`SENASA-Embalaje×${document.getElementById('n_senasa_p').value}`);
  if(!esMultinota && !esAdicionales && document.getElementById('chk_senasa_prod').checked) adicTags.push('SENASA-Prod');
  if(document.getElementById('chk_hojas').checked)      adicTags.push(`Hojas×${document.getElementById('n_hojas').value}`);
  if(document.getElementById('chk_mic').checked){
    const numMic = document.getElementById('n_mic_num').value.trim() || document.getElementById('op_mic').value.trim() || 's/n';
    adicTags.push(`MIC:${numMic}`);
  }
  if(esMultinota) adicTags.push('Multinota');
  if(esAdicionales) adicTags.push('Adicionales');
  if(document.getElementById('chk_mic_fojas').checked)  adicTags.push(`FojaMIC×${document.getElementById('n_mic_fojas').value}`);
  if(document.getElementById('chk_finsem').checked)     adicTags.push('F/S');
  if(document.getElementById('chk_mov_ad').checked)     adicTags.push('MOV AD');

  return {
    fecha: document.getElementById('op_fecha').value,
    despachante: document.getElementById('op_despachante').value.trim().toUpperCase(),
    cliente: document.getElementById('op_cliente').value.trim().toUpperCase(),
    destinacion: esAdicionales ? '' : document.getElementById('op_destinacion').value.trim().toUpperCase(),
    canal: (esMIC || esMultinota || esAdicionales) ? '' : document.getElementById('op_canal').value,
    zpa: document.getElementById('op_zpa').value.trim().toUpperCase(),
    tipo: document.getElementById('op_tipo').value,
    mic: document.getElementById('op_mic').value.trim().toUpperCase(),
    toma: document.getElementById('op_toma').value.trim(),
    tc,
    totalUsd,
    neto: totalNeto,
    iva,
    bruto,
    adicionales: adicTags.join(', '),
    obs: document.getElementById('op_obs').value.trim(),
    periodoFactura: document.getElementById('op_periodo_factura').value,
    tieneFactura,
    esPremium:    tipo === 'desp_externo',
    esKotinya:    tipo === 'kotinya',
    esApoderado:  tipo === 'apoderado',
    ramiroDeuda:  tipo === 'kotinya' ? (parseFloat(document.getElementById('t_ramiro_op').value) || 30) : 0,
    esMIC,
    esMultinota,
    esAdicionales,
    // Estado crudo del formulario (para poder reconstruirlo exacto al editar)
    tipoDespGlobal: tipo,
    opTcInput: document.getElementById('op_tc').value,
    adicionalesPesos: parseFloat(document.getElementById('op_adicionales_pesos').value) || 0,
    adicionalesUsd: parseFloat(document.getElementById('op_adicionales_usd').value) || 0,
    chk_sobre: document.getElementById('chk_sobre').checked,
    chk_cam: document.getElementById('chk_cam').checked,
    n_cam: document.getElementById('n_cam').value,
    chk_senasa_p: document.getElementById('chk_senasa_p').checked,
    n_senasa_p: document.getElementById('n_senasa_p').value,
    chk_senasa_prod: document.getElementById('chk_senasa_prod').checked,
    chk_hojas: document.getElementById('chk_hojas').checked,
    n_hojas: document.getElementById('n_hojas').value,
    chk_mic_check: document.getElementById('chk_mic').checked,
    n_mic_num: document.getElementById('n_mic_num').value,
    chk_mic_fojas: document.getElementById('chk_mic_fojas').checked,
    n_mic_fojas: document.getElementById('n_mic_fojas').value,
    chk_finsem: document.getElementById('chk_finsem').checked,
    chk_mov_ad: document.getElementById('chk_mov_ad').checked
  };
}

// ── GUARDAR OPERACIÓN (nueva) ──
let guardandoOperacion = false; // evita doble-click / doble-submit mientras Firestore procesa
window.guardarOperacion = async function(){
  if(guardandoOperacion) return; // ya se está guardando, ignorar clicks repetidos

  const despachante = document.getElementById('op_despachante').value.trim().toUpperCase();
  const destinacion = document.getElementById('op_destinacion').value.trim().toUpperCase();
  const esAdicionalesTipo = document.getElementById('op_tipo').value === 'ADICIONALES';
  const tcVal = parseFloat(document.getElementById('op_tc').value);
  if(!tcVal || tcVal <= 0){
    toast('⚠️ Falta el TC de la operación — es obligatorio para guardar');
    document.getElementById('op_tc').focus();
    return;
  }
  if(!despachante){ toast('Seleccioná un despachante'); return; }
  if(!esAdicionalesTipo && !destinacion){ toast('Ingresá la destinación/permiso'); return; }

  const datos = construirDatosOperacion();
  const op = {
    numOp: generarNumOp(),
    ...datos,
    ramiroOPagado: 'no',
    cargadoPor: user.username,
    ts: Date.now()
  };

  const btn = document.getElementById('op-btn-guardar');
  const textoOriginal = btn.innerHTML;
  guardandoOperacion = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Guardando...';

  try {
    await addDoc(collection(db,'despachantees_ops'), op);
    toast('✅ Operación guardada: #' + op.numOp);
    limpiarFormulario();
  } catch(e){
    toast('❌ Error al guardar: ' + e.message);
  } finally {
    guardandoOperacion = false;
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
};

// ── ACTUALIZAR OPERACIÓN (edición) ──
let actualizandoOperacion = false; // evita doble-click / doble-submit mientras Firestore procesa
window.actualizarOperacion = async function(){
  if(!opEditandoId) return;
  if(actualizandoOperacion) return; // ya se está actualizando, ignorar clicks repetidos

  const despachante = document.getElementById('op_despachante').value.trim().toUpperCase();
  const destinacion = document.getElementById('op_destinacion').value.trim().toUpperCase();
  const esAdicionalesTipo = document.getElementById('op_tipo').value === 'ADICIONALES';
  const tcVal = parseFloat(document.getElementById('op_tc').value);
  if(!tcVal || tcVal <= 0){
    toast('⚠️ Falta el TC de la operación — es obligatorio para guardar');
    document.getElementById('op_tc').focus();
    return;
  }
  if(!despachante){ toast('Seleccioná un despachante'); return; }
  if(!esAdicionalesTipo && !destinacion){ toast('Ingresá la destinación/permiso'); return; }

  const datos = construirDatosOperacion();

  const btn = document.getElementById('op-btn-actualizar');
  const textoOriginal = btn.innerHTML;
  actualizandoOperacion = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Actualizando...';

  try {
    await updateDoc(doc(db,'despachantees_ops', opEditandoId), {
      ...datos,
      modificadoPor: user.username,
      tsEdit: Date.now()
    });
    toast('✅ Operación actualizada');
    cancelarEdicionOperacion();
  } catch(e){
    toast('❌ Error: ' + e.message);
  } finally {
    actualizandoOperacion = false;
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
};

// ── EDITAR OPERACIÓN: carga los datos en el formulario ──
window.editarOperacion = function(id){
  const o = operaciones.find(x => x.id === id);
  if(!o) return;
  opEditandoId = id;

  document.getElementById('op_fecha').value        = o.fecha || '';
  document.getElementById('op_despachante').value  = o.despachante || '';
  document.getElementById('op_cliente').value      = o.cliente || '';
  document.getElementById('op_destinacion').value  = o.destinacion || '';
  document.getElementById('op_zpa').value          = o.zpa || '';
  document.getElementById('op_mic').value          = o.mic || '';
  document.getElementById('op_toma').value         = o.toma || '';
  document.getElementById('op_obs').value          = o.obs || '';
  document.getElementById('op_periodo_factura').value = o.periodoFactura || 'diario';
  document.getElementById('op_canal').value        = o.canal || 'V';
  document.getElementById('op_tipo').value         = o.tipo || 'EXPO';
  document.getElementById('op_adicionales_pesos').value = o.adicionalesPesos || 0;
  document.getElementById('op_adicionales_usd').value   = o.adicionalesUsd || 0;
  document.getElementById('op_tc').value           = o.opTcInput || o.tc || 1440;

  tieneFactura = o.tieneFactura !== false;

  // Tipo de operación (EXPO/IMPO/TRAN/MIC/MULTINOTA) -> ajusta visibilidad de checks
  onTipoChange();

  // Tipo de despacho (despachante/premium/apoderado/kotinya)
  document.getElementById('tipo_desp_global').value =
    o.tipoDespGlobal || (o.esApoderado ? 'apoderado' : o.esKotinya ? 'kotinya' : o.esPremium ? 'desp_externo' : 'despachante');
  onTipoDespachoChange();

  // Restaurar checkboxes/cantidades (por si onTipoChange los reseteó)
  document.getElementById('chk_sobre').checked       = !!o.chk_sobre;
  document.getElementById('chk_cam').checked         = !!o.chk_cam;
  document.getElementById('n_cam').value             = o.n_cam || 1;
  document.getElementById('chk_senasa_p').checked    = !!o.chk_senasa_p;
  document.getElementById('n_senasa_p').value        = o.n_senasa_p || 1;
  document.getElementById('chk_senasa_prod').checked = !!o.chk_senasa_prod;
  document.getElementById('chk_hojas').checked       = !!o.chk_hojas;
  document.getElementById('n_hojas').value           = o.n_hojas || 1;
  document.getElementById('chk_mic').checked         = o.chk_mic_check !== undefined ? !!o.chk_mic_check : (o.tipo === 'MIC');
  document.getElementById('n_mic_num').value         = o.n_mic_num || '';
  document.getElementById('chk_mic_fojas').checked   = !!o.chk_mic_fojas;
  document.getElementById('n_mic_fojas').value       = o.n_mic_fojas || 1;
  document.getElementById('chk_finsem').checked      = !!o.chk_finsem;
  document.getElementById('chk_mov_ad').checked      = !!o.chk_mov_ad;

  recalcularFormulario();

  const badge = document.getElementById('op-edit-badge');
  badge.style.display = 'block';
  badge.textContent = `✏️ Editando operación #${o.numOp || ''} — ${o.despachante || ''}`;
  document.getElementById('op-btn-guardar').style.display    = 'none';
  document.getElementById('op-btn-actualizar').style.display = 'inline-flex';
  document.getElementById('op-btn-cancelar').style.display   = 'inline-flex';

  switchTab('cargar');
  document.getElementById('tab-cargar').scrollIntoView({behavior:'smooth'});
  toast('✏️ Operación cargada para editar');
};

// ── CANCELAR EDICIÓN ──
window.cancelarEdicionOperacion = function(){
  opEditandoId = null;
  document.getElementById('op-edit-badge').style.display = 'none';
  document.getElementById('op-btn-guardar').style.display    = 'inline-flex';
  document.getElementById('op-btn-actualizar').style.display = 'none';
  document.getElementById('op-btn-cancelar').style.display   = 'none';
  limpiarFormulario();
};

// ── ELIMINAR ──
window.eliminarOp = async function(id){
  if(!confirm('¿Eliminar esta operación?')) return;
  await deleteDoc(doc(db,'despachantees_ops',id));
  toast('Operación eliminada');
};

// ── LIMPIAR FORM ──
window.limpiarFormulario = function(){
  document.getElementById('op_despachante').value = '';
  document.getElementById('op_destinacion').value = '';
  document.getElementById('op_cliente').value = '';
  document.getElementById('op_obs').value = '';
  document.getElementById('op_mic').value = '';
  document.getElementById('op_toma').value = '';
  document.getElementById('op_adicionales_pesos').value = '0';
  document.getElementById('op_adicionales_usd').value = '0';
  document.getElementById('op_tc').value = '';
  document.getElementById('op_canal').value = 'V';
  document.getElementById('op_tipo').value = 'EXPO';
  document.getElementById('tipo_desp_global').value = 'despachante';
  document.querySelectorAll('.chk-item input[type=checkbox]').forEach(c => c.checked = false);
  cerrarAC('ac_despachante');
  cerrarAC('ac_cliente');
  esApoderado = false;
  esKotinya   = false;
  tieneFactura = true;
  onTipoChange();
  onTipoDespachoChange();
  recalcularFormulario();
};

// ── GUARDAR CLIENTE (despachante) ──
window.guardarCliente = async function(){
  const nombre = document.getElementById('cli_nombre').value.trim().toUpperCase();
  if(!nombre){ toast('Ingresá el nombre'); return; }
  const cli = {
    nombre,
    tipo: document.getElementById('cli_tipo').value,
    factura: document.getElementById('cli_factura').value,
    tieneFactura: document.getElementById('cli_tiene_factura').value,
    cuit: document.getElementById('cli_cuit').value.trim()
  };
  const id = nombre.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
  await setDoc(doc(db,'corresponsales_clientes', id), cli);
  document.getElementById('cli_nombre').value = '';
  document.getElementById('cli_cuit').value = '';
  toast('✅ Despachante guardado');
};

window.eliminarCliente = async function(id){
  if(!confirm('¿Eliminar despachante?')) return;
  await deleteDoc(doc(db,'corresponsales_clientes',id));
  toast('Despachante eliminado');
};

// ── GUARDAR / ELIMINAR CLIENTE FINAL (mudanzas y cliente final de operaciones) ──
window.guardarClienteFinal = async function(){
  const input = document.getElementById('clifinal_nombre');
  const nombre = input.value.trim().toUpperCase();
  if(!nombre){ toast('Ingresá el nombre del cliente'); return; }
  const id = nombre.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
  try {
    await setDoc(doc(db,'corresponsales_clientes_finales', id), { nombre });
    input.value = '';
    toast('✅ Cliente guardado: ' + nombre);
  } catch(e){
    toast('❌ Error al guardar: ' + e.message);
  }
};

window.eliminarClienteFinal = async function(id){
  if(!confirm('¿Eliminar este cliente? (no borra operaciones ni mudanzas ya cargadas con su nombre)')) return;
  try {
    await deleteDoc(doc(db,'corresponsales_clientes_finales', id));
    toast('Cliente eliminado');
  } catch(e){
    toast('❌ Error al eliminar: ' + e.message);
  }
};

function renderTablaClientesFinales(){
  const tbody = document.getElementById('tbody-clientes-finales');
  const paginacionEl = document.getElementById('clientesfinales-paginacion');
  if(!tbody) return;
  if(!clientesFinalesDocs.length){
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:24px;">Sin clientes cargados</td></tr>';
    if(paginacionEl) paginacionEl.innerHTML = '';
    return;
  }
  const ordenados = [...clientesFinalesDocs].sort((a,b) => a.nombre.localeCompare(b.nombre));
  const { pagina, page, totalPaginas } = paginarArray('clientesFinales', ordenados, PAGE_SIZE_GENERICO);
  tbody.innerHTML = pagina.map(c => {
    const cantOps  = operaciones.filter(o => o.cliente === c.nombre).length;
    const cantMud  = mudanzas.filter(m => m.cliente === c.nombre).length;
    return `<tr>
      <td><strong>${c.nombre}</strong></td>
      <td style="text-align:center;">${cantOps} op${cantOps===1?'':'s'} · ${cantMud} mud.</td>
      <td><button class="btn-danger" onclick="eliminarClienteFinal('${c.id}')">✕</button></td>
    </tr>`;
  }).join('');
  if(paginacionEl) paginacionEl.innerHTML = htmlPaginacionGenerica(page, totalPaginas, 'clientesFinales');
}
window.renderTablaClientesFinales = renderTablaClientesFinales;

// ── CALCULAR COBERTURA FIFO (pagos sin factura asignada se aplican a las operaciones más viejas) ──
// NOTA: esto sigue funcionando exactamente igual que antes (se usa para pintar la columna
// "Cobertura" del Listado, operación por operación) y compara contra o.bruto — no se toca,
// porque el pedido fue no modificar el Listado. Es un concepto distinto del saldo total.
function calcularCoberturaFIFO(nombre){
  const { pagado } = calcularSaldoDespachante(nombre);
  const ops = operaciones.filter(o => o.despachante === nombre).sort((a,b)=>(a.ts||0)-(b.ts||0));
  let restante = pagado;
  return ops.map(o => {
    const cubierto = Math.min(o.bruto||0, Math.max(0, restante));
    restante -= cubierto;
    return { ...o, cubierto, pendiente: (o.bruto||0) - cubierto };
  });
}
window.calcularCoberturaFIFO = calcularCoberturaFIFO;

// ── ASIGNAR N° FACTURA A UNA OPERACIÓN ──
window.asignarFactura = async function(id, numFactura){
  const val = (numFactura||'').trim().toUpperCase();
  try {
    await updateDoc(doc(db,'despachantees_ops', id), { numFactura: val });
    toast(val ? '🧾 Factura asignada: ' + val : 'Factura quitada');
  } catch(e){
    toast('❌ Error al asignar factura: ' + e.message);
  }
};

// ── ASIGNAR N° FACTURA EN LOTE (panel con rango de fechas) ──
window.toggleFacturaLotePanel = function(){
  const panel = document.getElementById('factura-lote-panel');
  const open = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  if(open){
    document.getElementById('lote_despachante').value = document.getElementById('filtro_despachante').value || '';
    document.getElementById('lote_fecha_desde').value = '';
    document.getElementById('lote_fecha_hasta').value = '';
    document.getElementById('lote_num_factura').value = '';
    actualizarPreviewLote();
  }
};

function opsParaLote(){
  const despachante = document.getElementById('lote_despachante').value;
  const desde = document.getElementById('lote_fecha_desde').value;
  const hasta = document.getElementById('lote_fecha_hasta').value;
  if(!despachante) return [];
  return operaciones.filter(o => o.despachante === despachante
    && (!desde || (o.fecha || '') >= desde)
    && (!hasta || (o.fecha || '') <= hasta)
    && !o.numFactura);
}
window.opsParaLote = opsParaLote;

window.actualizarPreviewLote = function(){
  const despachante = document.getElementById('lote_despachante').value;
  const prev = document.getElementById('lote-preview');
  if(!despachante){
    prev.innerHTML = '<span style="color:#dc2626;">⚠️ Elegí un despachante</span>';
    return;
  }
  const ops = opsParaLote();
  const totBruto = ops.reduce((a,b) => a + (b.bruto||0), 0);
  prev.innerHTML = ops.length
    ? `${ops.length} operación(es) sin factura por un total de $${fmt2(totBruto)}`
    : '<span style="color:#dc2626;">No hay operaciones sin factura con esos filtros</span>';
};

window.ejecutarAsignarFacturaMasiva = async function(){
  const despachante = document.getElementById('lote_despachante').value;
  if(!despachante){ toast('⚠️ Elegí un despachante'); return; }
  const ops = opsParaLote();
  if(!ops.length){ toast('No hay operaciones sin factura con esos filtros'); return; }
  const val = document.getElementById('lote_num_factura').value.trim().toUpperCase();
  if(!val){ toast('⚠️ Ingresá el N° de factura'); return; }
  for(const o of ops){
    await updateDoc(doc(db,'despachantees_ops', o.id), { numFactura: val });
  }
  toast(`✅ Factura ${val} asignada a ${ops.length} operaciones`);
  toggleFacturaLotePanel();
};

// ── RENDER TABLA OPERACIONES ──
function renderTabla(){
  const tbody = document.getElementById('tbody-ops');
  if(!datosCargados){
    tbody.innerHTML = '<tr><td colspan="18" style="text-align:center;padding:32px;"><span class="spinner dark"></span> Cargando operaciones...</td></tr>';
    document.getElementById('tfoot-ops').innerHTML = '';
    return;
  }
  const filtCorr  = document.getElementById('filtro_despachante')?.value || '';
  const filtMes   = document.getElementById('filtro_mes')?.value || '';
  const filtDesde = document.getElementById('filtro_fecha_desde')?.value || '';
  const filtHasta = document.getElementById('filtro_fecha_hasta')?.value || '';
  let ops = [...operaciones];
  if(filtCorr)  ops = ops.filter(o => o.despachante === filtCorr);
  if(filtMes)   ops = ops.filter(o => o.fecha && o.fecha.startsWith(filtMes));
  if(filtDesde) ops = ops.filter(o => (o.fecha||'') >= filtDesde);
  if(filtHasta) ops = ops.filter(o => (o.fecha||'') <= filtHasta);

  // Más nueva primero: la última operación cargada arriba de todo, y así hacia atrás.
  ops.sort((a,b) => (b.fecha||'').localeCompare(a.fecha||'') || (b.ts||0)-(a.ts||0));

  if(!ops.length){
    tbody.innerHTML = '<tr><td colspan="18" style="text-align:center;color:#94a3b8;padding:32px;">Sin operaciones</td></tr>';
    document.getElementById('tfoot-ops').innerHTML = '';
    document.getElementById('listado-paginacion').innerHTML = '';
    return;
  }

  // Cobertura FIFO por operación (solo relevante para pagos sin factura asignada)
  const coberturaPorId = {};
  [...new Set(ops.map(o=>o.despachante))].forEach(desp => {
    calcularCoberturaFIFO(desp).forEach(o => coberturaPorId[o.id] = o.pendiente);
  });

  const totalPaginas = Math.max(1, Math.ceil(ops.length / LISTADO_PAGE_SIZE));
  if(listadoPage > totalPaginas) listadoPage = totalPaginas;
  if(listadoPage < 1) listadoPage = 1;
  const inicio = (listadoPage - 1) * LISTADO_PAGE_SIZE;
  const opsPagina = ops.slice(inicio, inicio + LISTADO_PAGE_SIZE);

  tbody.innerHTML = opsPagina.map(o => {
    const pendiente = coberturaPorId[o.id];
    let coberturaHtml;
    if(o.numFactura){
      coberturaHtml = '<span class="tag" style="background:#dbeafe;color:#1e40af;">Por factura</span>';
    } else if(pendiente > 0.5){
      coberturaHtml = `<span class="tag" style="background:#fee2e2;color:#991b1b;">$${fmt2(pendiente)} pend.</span>`;
    } else {
      coberturaHtml = '<span class="tag" style="background:#dcfce7;color:#166534;">✅ Cubierta</span>';
    }
    return `
    <tr>
      <td class="mono">${o.numOp||'-'}</td>
      <td>${o.fecha||''}</td>
      <td><strong>${o.despachante||''}</strong>${o.esPremium?'<span class="tag" style="background:#fef3c7;color:#92400e;margin-left:4px;">PREM</span>':o.esKotinya?'<span class="tag" style="background:#fef9c3;color:#92400e;margin-left:4px;">KOT</span>':o.esApoderado?'<span class="tag" style="background:#ede9fe;color:#5b21b6;margin-left:4px;">APOD</span>':''}</td>
      <td>${o.cliente||''}</td>
      <td class="mono">${o.destinacion||''}</td>
      <td class="mono">${o.mic||'-'}</td>
      <td style="font-size:11px;color:#64748b;max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="${o.toma||''}">${o.toma||'-'}</td>
      <td>${(o.tipo==='MIC'||o.tipo==='MULTINOTA') ? '-' : `<span class="canal-badge canal-${o.canal||'V'}">${o.canal||'V'}</span>`}</td>
      <td class="mono">${o.tc||''}</td>
      <td class="mono">${o.totalUsd||''}</td>
      <td style="color:#1e3a8a;font-weight:600;">$${fmt2(o.neto)}</td>
      <td>$${fmt2(o.iva)}</td>
      <td style="color:#059669;font-weight:700;">$${fmt2(o.bruto)}</td>
      <td>
        <input type="text" style="width:100px;border:1px solid #e2e8f0;border-radius:6px;padding:4px 6px;font-size:11px;font-family:monospace;"
          value="${o.numFactura||''}" placeholder="s/fact"
          onchange="asignarFactura('${o.id}', this.value)">
      </td>
      <td>${coberturaHtml}</td>
      <td>${o.adicionales ? o.adicionales.split(',').map(a=>`<span class="tag">${a.trim()}</span>`).join('') : '-'}</td>
      <td style="color:#64748b;font-size:11px;">${o.obs||''}</td>
      <td style="display:flex;gap:6px;">
        <button class="btn-outline" style="padding:4px 10px;font-size:12px;" onclick="editarOperacion('${o.id}')">✏️ Editar</button>
        <button class="btn-danger" onclick="eliminarOp('${o.id}')">✕</button>
      </td>
    </tr>
  `;
  }).join('');

  const totNeto  = ops.reduce((a,b) => a+(b.neto||0), 0);
  const totIva   = ops.reduce((a,b) => a+(b.iva||0), 0);
  const totBruto = ops.reduce((a,b) => a+(b.bruto||0), 0);
  const totUsd   = ops.reduce((a,b) => a+(b.totalUsd||0), 0);
  document.getElementById('tfoot-ops').innerHTML = `
    <tr style="background:#f0f4f8;font-weight:700;border-top:2px solid #1e3a8a;">
      <td colspan="9">TOTAL (${ops.length} ops)</td>
      <td class="mono">${totUsd.toFixed(2)}</td>
      <td style="color:#1e3a8a;">$${fmt2(totNeto)}</td>
      <td>$${fmt2(totIva)}</td>
      <td style="color:#059669;">$${fmt2(totBruto)}</td>
      <td colspan="5"></td>
    </tr>`;

  document.getElementById('listado-paginacion').innerHTML = `
    <div class="pagin-bar">
      <button onclick="cambiarPaginaListado(-1)" ${listadoPage<=1?'disabled':''}>‹ Anterior</button>
      <span>${listadoPage}/${totalPaginas}</span>
      <button onclick="cambiarPaginaListado(1)" ${listadoPage>=totalPaginas?'disabled':''}>Siguiente ›</button>
    </div>`;
}
window.renderTabla = renderTabla;

window.cambiarPaginaListado = function(delta){
  listadoPage += delta;
  renderTabla();
};

window.resetPaginaListado = function(){
  listadoPage = 1;
  renderTabla();
};

// ── RENDER FILTROS ──
function renderFiltros(){
  const corrSel  = document.getElementById('filtro_despachante');
  const mesSel   = document.getElementById('filtro_mes');
  const corrSelD = document.getElementById('dash_despachante');
  const mesSelD  = document.getElementById('dash_mes');
  const loteSel  = document.getElementById('lote_despachante');

  const nombres = [...new Set(clientes.map(c => c.nombre))].sort();
  const meses   = [...new Set(operaciones.map(o => o.fecha?.slice(0,7)).filter(Boolean))].sort().reverse();

  [corrSel, corrSelD, loteSel].forEach(sel => {
    if(!sel) return;
    const v = sel.value;
    sel.innerHTML = '<option value="">' + (sel===loteSel ? 'Seleccioná...' : 'Todos los despachantes') + '</option>';
    nombres.forEach(n => { const opt = document.createElement('option'); opt.value=n; opt.textContent=n; sel.appendChild(opt); });
    sel.value = v;
  });
  [mesSel, mesSelD].forEach(sel => {
    if(!sel) return;
    const v = sel.value;
    sel.innerHTML = '<option value="">Todos los meses</option>';
    meses.forEach(m => { const opt = document.createElement('option'); opt.value=m; opt.textContent=m; sel.appendChild(opt); });
    sel.value = v;
    // Tanto el mes del Dashboard como el del Listado: se aseguran de tener el mes actual
    // como opción (aunque todavía no haya operaciones cargadas ese mes) y arrancan
    // seleccionados en el mes en curso hasta que el usuario elija otro mes a mano
    // (incluido "Todos los meses"). Se recalcula en CADA render de filtros, no solo una vez.
    const mesActual = new Date().toISOString().slice(0,7);
    if(![...sel.options].some(o => o.value === mesActual)){
      const opt = document.createElement('option');
      opt.value = mesActual;
      opt.textContent = mesActual;
      sel.insertBefore(opt, sel.options[1] || null);
    }
    if(sel === mesSelD && !usuarioEligioMesDash){
      sel.value = mesActual;
    }
    if(sel === mesSel && !usuarioEligioMesListado){
      sel.value = mesActual;
    }
  });
}

// ── RENDER DASHBOARD ──
window.renderDashboard = function(){
  const filtMes  = document.getElementById('dash_mes')?.value || '';
  const filtCorr = document.getElementById('dash_despachante')?.value || '';
  let ops = [...operaciones];
  if(filtMes)  ops = ops.filter(o => o.fecha?.startsWith(filtMes));
  if(filtCorr) ops = ops.filter(o => o.despachante === filtCorr);

  // Mudanzas: no tienen "despachante", solo se filtran por mes. Si hay un despachante
  // seleccionado, se muestran aparte (no se mezclan en los totales de ese despachante).
  const mudFiltradas = mudanzas.filter(m => !filtMes || m.fecha?.startsWith(filtMes));
  const incluirMudEnTotales = !filtCorr;

  const totBrutoOps = ops.reduce((a,b) => a+(b.bruto||0), 0);
  const totNetoOps  = ops.reduce((a,b) => a+(b.neto||0), 0);
  const totUsdOps   = ops.reduce((a,b) => a+(b.totalUsd||0), 0);
  const totBrutoMud = mudFiltradas.reduce((a,b) => a+(b.bruto||0), 0);
  const totNetoMud  = mudFiltradas.reduce((a,b) => a+(b.honorNeto||0), 0);
  const totUsdMud   = mudFiltradas.reduce((a,b) => a+(b.valorUsd||0), 0);

  const totBruto = totBrutoOps + (incluirMudEnTotales ? totBrutoMud : 0);
  const totNeto  = totNetoOps  + (incluirMudEnTotales ? totNetoMud  : 0);
  const totUsd   = totUsdOps   + (incluirMudEnTotales ? totUsdMud   : 0);
  const cantTotal = ops.length + (incluirMudEnTotales ? mudFiltradas.length : 0);

  const canales  = {V:0,N:0,R:0};
  ops.forEach(o => { if(canales[o.canal]!==undefined) canales[o.canal]++; });

  // ── "Cobrado" y "Pendiente" son del PERÍODO filtrado (mes elegido arriba), no históricos ──
  const despFiltrados = [...new Set(ops.map(o => o.despachante).filter(Boolean))];
  let totCobradoPeriodo = pagos
    .filter(p => despFiltrados.includes(p.despachante) && (!filtMes || (p.fecha||'').startsWith(filtMes)))
    .reduce((a,b) => a + (b.monto||0), 0);

  // Mudanzas: cobradas/sin cobrar ya vienen filtradas por el mismo período (mudFiltradas)
  const mudPagado    = mudFiltradas.filter(m => m.cobrado).reduce((a,b) => a + (b.bruto||0), 0);
  const mudPendiente = mudFiltradas.filter(m => !m.cobrado).reduce((a,b) => a + (b.bruto||0), 0);
  if(incluirMudEnTotales){
    totCobradoPeriodo += mudPagado;
  }

  // Pendiente del período = lo facturado en el período menos lo cobrado en ese mismo período
  const totPendientePeriodo = totBruto - totCobradoPeriodo;

  // ── "Deuda total pendiente HOY" es SIEMPRE histórica y total, ignora el filtro de mes ──
  // (solo respeta el filtro de despachante, si eligió uno puntual)
  const nombresParaDeuda = filtCorr ? [filtCorr] : [...new Set(clientes.map(c => c.nombre))];
  const deudaDespachantesHoy = nombresParaDeuda.reduce((a,n) => a + calcularSaldoDespachante(n).saldo, 0);
  const mudPendienteHoy = filtCorr ? 0 : mudanzas.filter(m => !m.cobrado).reduce((a,b) => a + (b.bruto||0), 0);
  const deudaTotalHoy = deudaDespachantesHoy + mudPendienteHoy;

  document.getElementById('kpis-wrap').innerHTML = `
    <div class="kpi accent">
      <div class="kpi-label">Operaciones${incluirMudEnTotales?' + Mudanzas':''}</div>
      <div class="kpi-val">${cantTotal}</div>
      <div class="kpi-sub">V:${canales.V} N:${canales.N} R:${canales.R}${incluirMudEnTotales?` · Mudanzas: ${mudFiltradas.length}`:''}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Facturado (este período)</div>
      <div class="kpi-val">$${fmt2(totBruto)}</div>
      <div class="kpi-sub">Neto: $${fmt2(totNeto)}${incluirMudEnTotales&&mudFiltradas.length?` (incl. mudanzas)`:''}</div>
    </div>
    <div class="kpi" style="border-color:#86efac;background:#f0fdf4;">
      <div class="kpi-label">💰 Cobrado (este período)</div>
      <div class="kpi-val" style="color:#059669;">$${fmt2(totCobradoPeriodo)}</div>
      <div class="kpi-sub">${incluirMudEnTotales&&mudFiltradas.length?`Incl. mudanzas cobradas: $${fmt2(mudPagado)}`:''}</div>
    </div>
    <div class="kpi" style="border-color:${totPendientePeriodo>0.005?'#fca5a5':'#86efac'};background:${totPendientePeriodo>0.005?'#fef2f2':'#f0fdf4'};">
      <div class="kpi-label">⚖️ Pendiente (este período)</div>
      <div class="kpi-val" style="color:${totPendientePeriodo>0.005?'#dc2626':'#059669'};">$${fmt2(totPendientePeriodo)}</div>
      <div class="kpi-sub">${incluirMudEnTotales&&mudFiltradas.length?`Incl. mudanzas sin cobrar: $${fmt2(mudPendiente)}`:'Facturado − cobrado del período'}</div>
    </div>
    <div class="kpi" style="border-color:#fca5a5;background:#fef2f2;grid-column:span 1;">
      <div class="kpi-label">🔴 Deuda total pendiente HOY</div>
      <div class="kpi-val" style="color:#dc2626;font-size:30px;">$${fmt2(deudaTotalHoy)}</div>
      <div class="kpi-sub">${filtCorr ? `Solo ${filtCorr}` : `Despachantes: $${fmt2(deudaDespachantesHoy)} · Mudanzas: $${fmt2(mudPendienteHoy)}`}</div>
    </div>
    ${!incluirMudEnTotales && mudFiltradas.length ? `
    <div class="kpi" style="border-color:#bfdbfe;background:#eff6ff;">
      <div class="kpi-label">📦 Mudanzas del período (aparte)</div>
      <div class="kpi-val" style="color:#1e3a8a;">$${fmt2(totBrutoMud)}</div>
      <div class="kpi-sub">${mudFiltradas.length} mudanza(s) · no se filtran por despachante</div>
    </div>` : ''}
  `;

  // "Por despachante" siempre muestra el MES EN CURSO (no depende del selector de mes del
  // dashboard). El saldo mostrado es el saldo HISTÓRICO real (incluye deuda de meses
  // anteriores), igual al de la pestaña Saldos.
  const _mesActualDash = new Date().toISOString().slice(0,7);
  const opsMesActual = operaciones.filter(o => o.fecha?.startsWith(_mesActualDash) && (!filtCorr || o.despachante === filtCorr));

  const byCorr = {};
  opsMesActual.forEach(o => {
    if(!byCorr[o.despachante]) byCorr[o.despachante] = {ops:0, bruto:0};
    byCorr[o.despachante].ops++;
    byCorr[o.despachante].bruto += o.bruto||0;
  });
  // Incluir también a los despachantes que tuvieron un PAGO este mes aunque no
  // hayan cargado ninguna operación este mes (para que no desaparezcan de la tabla).
  pagos.filter(p => (p.fecha||'').startsWith(_mesActualDash)).forEach(p => {
    if(!byCorr[p.despachante]) byCorr[p.despachante] = {ops:0, bruto:0};
  });

  // Mudanzas por cliente (siempre se muestra, filtrado solo por mes)
  const byClienteMud = {};
  mudFiltradas.forEach(m => {
    const cl = m.cliente || 'Sin nombre';
    if(!byClienteMud[cl]) byClienteMud[cl] = {cant:0, bruto:0};
    byClienteMud[cl].cant++;
    byClienteMud[cl].bruto += m.bruto||0;
  });

  // Mudanzas con residencia pendiente (amarillo o rojo) — no depende de los filtros del dashboard,
  // es un estado vigente independiente del mes/despachante seleccionado.
  const mudResidenciaPendiente = mudanzas
    .map(m => ({ ...m, _est: estadoResidencia(m) }))
    .filter(m => m._est.clase !== 'ok')
    .sort((a,b) => (a.vencimientoResidencia||'').localeCompare(b.vencimientoResidencia||''));

  document.getElementById('dash-detalle').innerHTML = `
    <div class="section-card" style="margin:0;">
      <h3>Despachantes — mes en curso (${_mesActualDash})</h3>
      <table style="width:100%;font-size:11.5px;border-collapse:collapse;">
        <thead><tr style="background:#f0f4f8;color:#1e3a8a;"><th style="padding:5px 6px;text-align:left;">Despachante</th><th style="padding:5px 6px;text-align:right;">Ops</th><th style="padding:5px 6px;text-align:right;">Total $</th><th style="padding:5px 6px;text-align:right;">Pagado $</th><th style="padding:5px 6px;text-align:right;">Saldo $</th></tr></thead>
        <tbody>
          ${Object.entries(byCorr).sort((a,b)=>b[1].bruto-a[1].bruto).map(([k,v]) => {
            const pagadoMes = pagos.filter(p => p.despachante === k && (p.fecha||'').startsWith(_mesActualDash)).reduce((a,b)=>a+(b.monto||0),0);
            const { saldo } = calcularSaldoDespachante(k); // saldo histórico real (incluye deuda de meses anteriores)
            const colorSaldo = saldo > 0.005 ? '#dc2626' : (saldo < -0.005 ? '#059669' : '#64748b');
            return `<tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:5px 6px;">${k}</td><td style="padding:5px 6px;text-align:right;">${v.ops}</td><td style="padding:5px 6px;text-align:right;font-weight:700;color:#059669;">$${fmt2(v.bruto)}</td><td style="padding:5px 6px;text-align:right;color:#059669;">$${fmt2(pagadoMes)}</td><td style="padding:5px 6px;text-align:right;font-weight:700;color:${colorSaldo};">$${fmt2(saldo)}</td></tr>`;
          }).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:12px;">Sin operaciones ni pagos este mes</td></tr>'}
        </tbody>
      </table>
      <div style="font-size:11px;color:#94a3b8;margin-top:8px;">💡 "Total" y "Pagado" son del mes en curso. "Saldo" es el saldo histórico real (Neto de operaciones sin factura + Neto+IVA de operaciones ya facturadas, menos pagos), igual al que ves en la pestaña Saldos.</div>
    </div>
    <div class="section-card" style="margin:0;">
      <h3>🏠 Residencia pendiente</h3>
      <table style="width:100%;font-size:11.5px;border-collapse:collapse;">
        <thead><tr style="background:#f0f4f8;color:#1e3a8a;"><th style="padding:5px 6px;text-align:left;">Cliente final</th><th style="padding:5px 6px;text-align:left;">Cliente</th><th style="padding:5px 6px;text-align:left;">Vencimiento</th><th style="padding:5px 6px;text-align:left;">Estado</th></tr></thead>
        <tbody>
          ${mudResidenciaPendiente.map(m =>
            `<tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:5px 6px;"><strong>${m.clienteFinal||'-'}</strong></td><td style="padding:5px 6px;">${m.cliente||''}</td><td style="padding:5px 6px;" class="mono">${m.vencimientoResidencia||''}</td><td style="padding:5px 6px;"><span class="tag" style="background:${m._est.bg};color:${m._est.color};">${m._est.label}</span></td></tr>`
          ).join('') || '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:12px;">Sin residencias pendientes 🎉</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="section-card" style="margin:0;">
      <h3>📦 Mudanzas por cliente</h3>
      <table style="width:100%;font-size:11.5px;border-collapse:collapse;">
        <thead><tr style="background:#f0f4f8;color:#1e3a8a;"><th style="padding:5px 6px;text-align:left;">Cliente</th><th style="padding:5px 6px;text-align:right;">Cant.</th><th style="padding:5px 6px;text-align:right;">Total $</th></tr></thead>
        <tbody>
          ${Object.entries(byClienteMud).sort((a,b)=>b[1].bruto-a[1].bruto).map(([k,v]) =>
            `<tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:7px;">${k}</td><td style="padding:7px;text-align:right;">${v.cant}</td><td style="padding:7px;text-align:right;font-weight:700;color:#059669;">$${fmt2(v.bruto)}</td></tr>`
          ).join('') || '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:12px;">Sin mudanzas en el período</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
};

// ── CORREGIR ETIQUETAS VIEJAS (Sobre→Armado, SENASA-P→SENASA-Embalaje) ──
window.migrarEtiquetasAdicionales = async function(){
  if(!confirm('Esto va a corregir el texto de "Sobre" → "Armado", "SENASA-P" → "SENASA-Embalaje" y va a quitar el canal (V/N/R) de las operaciones MIC y Multinota ya guardadas. ¿Continuar?')) return;

  const btn = document.getElementById('btn-corregir-etiquetas');
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner dark"></span> Corrigiendo...';

  try {
    let corregidas = 0;
    for(const o of operaciones){
      const cambios = {};

      if(o.adicionales){
        const nuevo = o.adicionales
          .replace(/\bSobre\b/g, 'Armado')
          .replace(/SENASA-P(?=×|,|$)/g, 'SENASA-Embalaje');
        if(nuevo !== o.adicionales) cambios.adicionales = nuevo;
      }

      if((o.tipo === 'MIC' || o.tipo === 'MULTINOTA') && o.canal){
        cambios.canal = '';
      }

      if(Object.keys(cambios).length){
        await updateDoc(doc(db,'despachantees_ops', o.id), cambios);
        corregidas++;
      }
    }
    toast(corregidas ? `✅ ${corregidas} operaciones corregidas` : 'No había operaciones para corregir');
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
};

// ── MONTO EXIGIBLE POR OPERACIÓN (usado SOLO para calcular saldos) ──
// Mientras la operación NO tenga N° de factura cargado (numFactura vacío), el IVA es
// puramente informativo: lo único que se le puede reclamar al despachante es el NETO,
// porque todavía no existe factura de ARCA que respalde ese IVA. Recién cuando se carga
// el N° de factura (asignarFactura / lote / al facturar por ARCA), la operación pasa a
// estar "Facturada" y el IVA se incorpora al monto exigible (Neto + IVA = Bruto).
//
// OJO: esto NO toca neto/iva/bruto en ningún lado. Esos tres valores se siguen calculando
// igual que siempre (getTarifas / construirDatosOperacion) y se siguen mostrando igual en
// la carga, el Listado, el Dashboard, las planillas Excel y los recibos. Esta función se
// usa exclusivamente adentro de calcularSaldoDespachante, para no confundir "lo facturado"
// (bruto, informativo) con "lo que hoy se le puede cobrar" (exigible).
function montoExigible(o){
  const facturada = !!(o.numFactura && String(o.numFactura).trim());
  return facturada ? (o.bruto||0) : (o.neto||0);
}
window.montoExigible = montoExigible;

// ── PAGOS Y SALDOS POR DESPACHANTE ──
function calcularSaldoDespachante(nombre){
  const ops = operaciones.filter(o => o.despachante === nombre);
  // "facturado" se mantiene igual que siempre: total bruto histórico (neto+IVA de todas las
  // operaciones, tengan o no factura cargada). Es un dato informativo, no cambia.
  const facturado = ops.reduce((a,b) => a + (b.bruto||0), 0);
  // "exigible" es el monto nuevo que se usa para el saldo: neto en operaciones sin factura,
  // neto+IVA (bruto) en las que ya tienen N° de factura cargado.
  const exigible  = ops.reduce((a,b) => a + montoExigible(b), 0);
  const pagado    = pagos.filter(p => p.despachante === nombre).reduce((a,b) => a + (b.monto||0), 0);
  // El saldo pendiente ahora se calcula contra lo exigible, NO contra el bruto total.
  // Mientras no haya factura: saldo = neto - pagos. Facturada: saldo = neto + iva - pagos.
  return { facturado, exigible, pagado, saldo: exigible - pagado };
}
window.calcularSaldoDespachante = calcularSaldoDespachante;

window.guardarPago = async function(){
  const despachante = document.getElementById('pago_despachante').value;
  const fecha       = document.getElementById('pago_fecha').value;
  const monto       = parseFloat(document.getElementById('pago_monto').value);
  const obs         = document.getElementById('pago_obs').value.trim();

  if(!despachante){ toast('Seleccioná un despachante'); return; }
  if(!fecha){ toast('Ingresá la fecha del pago'); return; }
  if(!monto || monto <= 0){ toast('Ingresá un monto de pago válido'); return; }

  try {
    await addDoc(collection(db,'despachantees_pagos'), {
      despachante, fecha, monto, obs,
      cargadoPor: user.username,
      ts: Date.now()
    });
    toast('✅ Pago registrado: $' + fmt(monto) + ' — ' + despachante);
    document.getElementById('pago_monto').value = '';
    document.getElementById('pago_obs').value = '';
  } catch(e){
    toast('❌ Error al registrar el pago: ' + e.message);
  }
};

window.eliminarPago = async function(id){
  if(!confirm('¿Eliminar este pago?')) return;
  await deleteDoc(doc(db,'despachantees_pagos', id));
  toast('Pago eliminado');
};

function renderSaldos(){
  // Select de despachantes
  const sel = document.getElementById('pago_despachante');
  if(sel){
    const v = sel.value;
    const nombres = [...new Set(clientes.map(c => c.nombre))].sort();
    sel.innerHTML = '<option value="">Seleccioná...</option>' +
      nombres.map(n => `<option value="${n}">${n}</option>`).join('');
    sel.value = v;
  }
  const fechaEl = document.getElementById('pago_fecha');
  if(fechaEl && !fechaEl.value) fechaEl.value = new Date().toISOString().split('T')[0];

  // Tabla de saldos por despachante
  const tbodySaldos = document.getElementById('tbody-saldos');
  if(tbodySaldos){
    const nombresConOps = [...new Set(operaciones.map(o => o.despachante).filter(Boolean))].sort();
    if(!nombresConOps.length){
      tbodySaldos.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:16px;">Sin operaciones cargadas</td></tr>';
    } else {
      tbodySaldos.innerHTML = nombresConOps.map(n => {
        const { facturado, pagado, saldo } = calcularSaldoDespachante(n);
        const colorSaldo = saldo > 0.005 ? '#dc2626' : (saldo < -0.005 ? '#059669' : '#64748b');
        const etiqueta    = saldo > 0.005 ? '⚠️ Debe' : (saldo < -0.005 ? '✅ A favor' : '✔ Al día');
        // Indicador: ¿tiene este despachante operaciones sin factura aún (IVA no exigible)?
        const opsDelDesp = operaciones.filter(o => o.despachante === n);
        const tieneSinFacturar = opsDelDesp.some(o => !(o.numFactura && String(o.numFactura).trim()));
        const ivaNoExigible = opsDelDesp
          .filter(o => !(o.numFactura && String(o.numFactura).trim()))
          .reduce((a,b) => a + (b.iva||0), 0);
        const notaIva = tieneSinFacturar && ivaNoExigible > 0.005
          ? ` <span class="tag" style="background:#fef9c3;color:#92400e;" title="IVA aún no exigible (sin factura emitida) — no está incluido en el saldo">IVA s/facturar: $${fmt2(ivaNoExigible)}</span>`
          : '';
        return `<tr>
          <td><strong>${n}</strong></td>
          <td>$${fmt2(facturado)}</td>
          <td style="color:#059669;">$${fmt2(pagado)}</td>
          <td style="font-weight:700;color:${colorSaldo};">$${fmt2(saldo)} <span style="font-weight:600;font-size:11px;">${etiqueta}</span>${notaIva}</td>
        </tr>`;
      }).join('');
    }
  }

  // Nota explicativa fija debajo de la tabla de Saldos (se agrega una sola vez)
  const tablaSaldosCard = tbodySaldos ? tbodySaldos.closest('.section-card') : null;
  if(tablaSaldosCard && !document.getElementById('nota-saldo-iva')){
    const nota = document.createElement('div');
    nota.id = 'nota-saldo-iva';
    nota.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:8px;';
    nota.innerHTML = '💡 El <strong>Saldo pendiente</strong> se calcula sobre el <strong>Neto</strong> mientras la operación no tenga N° de factura cargado (el IVA es informativo hasta ese momento). Cuando se carga el N° de factura en el Listado, esa operación pasa a "Facturada" y su IVA se suma al saldo exigible.';
    tablaSaldosCard.appendChild(nota);
  }

  // Historial de pagos
  const tbodyHist = document.getElementById('tbody-pagos-hist');
  const pagosPaginacionEl = document.getElementById('pagos-paginacion');
  if(tbodyHist){
    if(!pagos.length){
      tbodyHist.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:16px;">Sin pagos registrados</td></tr>';
      if(pagosPaginacionEl) pagosPaginacionEl.innerHTML = '';
    } else {
      // Más nuevo primero (último pago cargado arriba de todo)
      const ordenados = [...pagos].sort((a,b) => (b.fecha||'').localeCompare(a.fecha||'') || (b.ts||0)-(a.ts||0));
      const { pagina, page, totalPaginas } = paginarArray('pagos', ordenados, PAGE_SIZE_GENERICO);
      tbodyHist.innerHTML = pagina.map(p => `
        <tr>
          <td>${p.fecha||''}</td>
          <td><strong>${p.despachante||''}</strong>${p.numFactura?` <span class="tag" style="background:#dbeafe;color:#1e40af;">Fact. ${p.numFactura}</span>`:(p.origenCaja?' <span class="tag" style="background:#dcfce7;color:#166534;">Auto Caja</span>':'')}</td>
          <td style="color:#059669;font-weight:700;">$${fmt2(p.monto)}</td>
          <td style="font-size:11px;color:#64748b;">${p.obs||''}</td>
          <td><button class="btn-danger" onclick="eliminarPago('${p.id}')">✕</button></td>
        </tr>
      `).join('');
      if(pagosPaginacionEl) pagosPaginacionEl.innerHTML = htmlPaginacionGenerica(page, totalPaginas, 'pagos');
    }
  }
}
window.renderSaldos = renderSaldos;

// ── RENDER TABLA CLIENTES (DESPACHANTES) ──
function renderTablaClientes(){
  const tbody = document.getElementById('tbody-clientes');
  const paginacionEl = document.getElementById('clientes-paginacion');
  if(!clientes.length){
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px;">Sin despachantes cargados</td></tr>';
    if(paginacionEl) paginacionEl.innerHTML = '';
    return;
  }
  const ordenados = [...clientes].sort((a,b) => (a.nombre||'').localeCompare(b.nombre||''));
  const { pagina, page, totalPaginas } = paginarArray('clientesDesp', ordenados, PAGE_SIZE_GENERICO);
  tbody.innerHTML = pagina.map(c => {
    const opsCount = operaciones.filter(o => o.despachante === c.nombre).length;
    const et = etiquetaTipoDespachante(c.tipo);
    return `<tr>
      <td><strong>${c.nombre}</strong></td>
      <td><span class="tag" style="${et.style}">${et.txt}</span></td>
      <td>${c.factura||'-'}</td>
      <td>${c.tieneFactura === 'no' ? '❌ No' : '✅ Sí'}</td>
      <td class="mono">${c.cuit||'-'}</td>
      <td style="text-align:center;">${opsCount}</td>
      <td><button class="btn-danger" onclick="eliminarCliente('${c.id}')">✕</button></td>
    </tr>`;
  }).join('');
  if(paginacionEl) paginacionEl.innerHTML = htmlPaginacionGenerica(page, totalPaginas, 'clientesDesp');
}

// ── EXPORTAR EXCEL ──
window.exportarExcel = function(){
  const filtCorr = document.getElementById('filtro_despachante').value;
  const filtMes  = document.getElementById('filtro_mes').value;
  const filtDesde = document.getElementById('filtro_fecha_desde')?.value || '';
  const filtHasta = document.getElementById('filtro_fecha_hasta')?.value || '';
  let ops = [...operaciones];
  if(filtCorr) ops = ops.filter(o => o.despachante === filtCorr);
  if(filtMes)  ops = ops.filter(o => o.fecha?.startsWith(filtMes));
  if(filtDesde) ops = ops.filter(o => (o.fecha||'') >= filtDesde);
  if(filtHasta) ops = ops.filter(o => (o.fecha||'') <= filtHasta);

  if(!ops.length){ toast('No hay operaciones para exportar con esos filtros'); return; }

  // Pagos que corresponden a los mismos filtros (mismo despachante / mismo rango de fechas de pago)
  let pagosFiltrados = [...pagos];
  if(filtCorr) pagosFiltrados = pagosFiltrados.filter(p => p.despachante === filtCorr);
  if(filtMes)  pagosFiltrados = pagosFiltrados.filter(p => p.fecha?.startsWith(filtMes));
  if(filtDesde) pagosFiltrados = pagosFiltrados.filter(p => (p.fecha||'') >= filtDesde);
  if(filtHasta) pagosFiltrados = pagosFiltrados.filter(p => (p.fecha||'') <= filtHasta);

  const fmtFechaAR = (iso) => {
    if(!iso) return '';
    const [y,m,d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };

  // Sin redondeo a entero: solo se recorta a 2 decimales (centavos exactos), nada de Math.round a pesos
  const dec2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  const header = ['FECHA','DESPACHANTE','CLIENTE','DESTINACIÓN','CANAL','ZPA','VALOR','IVA','SUB TOTAL','TC','VALOR USD','OBSERVAC'];

  const opsOrdenadas = [...ops].sort((a,b) => (a.fecha||'').localeCompare(b.fecha||''));

  const rows = opsOrdenadas.map(o => {
    const obsCompleto = [o.obs, o.adicionales].filter(Boolean).join(' | ');
    return [
      fmtFechaAR(o.fecha),
      o.despachante || '',
      o.cliente || '',
      o.destinacion || '',
      o.canal || '',
      o.zpa || '',
      dec2(o.neto),
      dec2(o.iva),
      dec2(o.bruto),
      o.tc || '',
      o.totalUsd || '',
      obsCompleto
    ];
  });

  const totNeto   = ops.reduce((a,b) => a + (b.neto||0), 0);
  const totIva    = ops.reduce((a,b) => a + (b.iva||0), 0);
  const totBruto  = ops.reduce((a,b) => a + (b.bruto||0), 0);
  const totPagado = pagosFiltrados.reduce((a,b) => a + (b.monto||0), 0);

  const totalRow = ['TOTAL',`${ops.length} op(s)`,'','','','', dec2(totNeto), dec2(totIva), dec2(totBruto), '', '', totPagado ? `Total pagado: $${fmt2(totPagado)}` : ''];

  const aoa = [header, ...rows, totalRow];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);

  ws['!cols'] = [
    {wch:11},{wch:18},{wch:22},{wch:20},{wch:7},{wch:7},
    {wch:12},{wch:12},{wch:14},{wch:8},{wch:10},{wch:32}
  ];

  // Autofiltro (flechitas de filtro) en la fila de encabezados, como en tu planilla
  const lastCol = XLSX.utils.encode_col(header.length - 1);
  ws['!autofilter'] = { ref: `A1:${lastCol}1` };

  // ── TOTAL con fórmula SUBTOTAL: al filtrar en Excel (autofiltro), estas celdas
  // recalculan solas y muestran la suma SOLO de las filas visibles/filtradas ──
  {
    const totalRowNum  = 2 + rows.length; // fila Excel (1-indexed) de la fila TOTAL
    const firstDataRow = 2;
    const lastDataRow  = 1 + rows.length;
    [6,7,8].forEach(c => { // VALOR, IVA, SUB TOTAL
      const colLetter = XLSX.utils.encode_col(c);
      const addr = XLSX.utils.encode_cell({ r: totalRowNum - 1, c });
      ws[addr] = { t:'n', v: totalRow[c], f: `SUBTOTAL(109,${colLetter}${firstDataRow}:${colLetter}${lastDataRow})` };
    });
  }

  // ── Estilo tipo planilla: recuadros en todas las celdas + encabezado destacado ──
  const finoGris  = { style: 'thin', color: { rgb: 'B8C2CC' } };
  const bordeTodo = { top: finoGris, bottom: finoGris, left: finoGris, right: finoGris };
  const colsNumericas = [6,7,8,9,10]; // VALOR, IVA, SUB TOTAL, TC, VALOR USD
  const colsDecimal2  = [6,7,8]; // columnas que siempre llevan 2 decimales exactos (sin redondeo a entero)
  const formatoDecimal = '#,##0.00';
  const totalRowIdx = 1 + rows.length; // fila 0-index del TOTAL

  const range = XLSX.utils.decode_range(ws['!ref']);
  for(let R = range.s.r; R <= range.e.r; R++){
    for(let C = range.s.c; C <= range.e.c; C++){
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if(!ws[addr]) ws[addr] = { t: 's', v: '' };

      // VALOR, IVA, SUB TOTAL siempre con 2 decimales exactos
      if(R > 0 && R !== totalRowIdx && colsDecimal2.includes(C) && typeof ws[addr].v === 'number'){
        ws[addr].z = formatoDecimal;
      }

      if(R === 0){
        // Encabezado: negrita, más grande, fondo azul, letra blanca
        ws[addr].s = {
          font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '1E3A8A' } },
          border: bordeTodo,
          alignment: { horizontal: 'center', vertical: 'center' }
        };
      } else if(R === totalRowIdx){
        // Fila TOTAL: negrita y destacada, con la suma de cada columna
        ws[addr].s = {
          font: { bold: true, sz: 11, color: { rgb: 'DC2626' } },
          fill: { fgColor: { rgb: 'FEF2F2' } },
          border: bordeTodo,
          alignment: { horizontal: colsNumericas.includes(C) ? 'right' : 'left' },
          numFmt: colsDecimal2.includes(C) ? formatoDecimal : undefined
        };
      } else {
        // Filas de datos (operaciones)
        ws[addr].s = {
          font: { sz: 10 },
          border: bordeTodo,
          alignment: { horizontal: colsNumericas.includes(C) ? 'right' : 'left' },
          numFmt: colsDecimal2.includes(C) ? formatoDecimal : undefined
        };
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Operaciones');

  const rangoNombre = (filtDesde || filtHasta) ? `${filtDesde||'inicio'}_a_${filtHasta||'hoy'}` : (filtMes||'todos');
  const nombreArchivo = `operaciones_${filtCorr||'todos'}_${rangoNombre}.xlsx`
    .replace(/\s+/g,'_');

  XLSX.writeFile(wb, nombreArchivo);
};

// ── MUDANZAS ──
window.recalcMudanza = function(){
  const tcInputEl = document.getElementById('mud_tc');
  const tcInput   = tcInputEl.value;
  const tcFalta   = tcInput === '' || isNaN(parseFloat(tcInput)) || parseFloat(tcInput) <= 0;
  const tc        = tcFalta ? 0 : parseFloat(tcInput);
  const usd       = parseFloat(document.getElementById('mud_valor_usd').value) || 0;
  const ramiroUsd = parseFloat(document.getElementById('mud_ramiro').value) || 190;
  const precinto  = parseFloat(document.getElementById('mud_precinto').value) || 0;
  const fiscal    = parseFloat(document.getElementById('mud_fiscal').value) || 0;
  const digitalizacion = parseFloat(document.getElementById('mud_digitalizacion').value) || 0;
  const otros     = parseFloat(document.getElementById('mud_otros').value) || 0;
  const mudTieneFactura = document.getElementById('mud_tiene_factura').value !== 'no';

  const honorNeto   = usd * tc;
  const iva         = mudTieneFactura ? honorNeto * 0.21 : 0;
  const bruto       = honorNeto + iva;
  const gastoRamiro = ramiroUsd * tc;
  const totalGastos = precinto + fiscal + digitalizacion + gastoRamiro + otros;
  const netofinal   = honorNeto - totalGastos;

  // Vista previa del estado de residencia en el formulario (si hay fecha cargada)
  const vencResidencia = document.getElementById('mud_venc_residencia')?.value || '';
  const residenciaCancelada = document.getElementById('mud_residencia_cancelada')?.value === 'si';
  const estRes = estadoResidencia({ vencimientoResidencia: vencResidencia, residenciaCancelada });

  if(tcFalta){
    tcInputEl.style.borderColor = '#dc2626';
    tcInputEl.style.background  = '#fef2f2';
    document.getElementById('mud_neto').textContent        = '⚠️ Falta TC';
    document.getElementById('mud_iva').textContent         = '⚠️ Falta TC';
    document.getElementById('mud_bruto').textContent       = '⚠️ Falta TC';
    document.getElementById('mud_gastos_total').textContent = '⚠️ Falta TC';
    document.getElementById('mud_neto_final').textContent  = '⚠️ Falta TC';
    document.getElementById('mud_desglose').innerHTML = '<span style="color:#dc2626;font-weight:700;">⚠️ Ingresá el Tipo de Cambio (TC) para calcular la liquidación. No se puede guardar sin este dato.</span>';
    return { tc, usd, honorNeto, iva, bruto, totalGastos, netofinal, gastoRamiro, precinto, fiscal, digitalizacion, otros, ramiroUsd, tcFalta, tieneFactura: mudTieneFactura, vencimientoResidencia: vencResidencia, residenciaCancelada };
  }

  tcInputEl.style.borderColor = '';
  tcInputEl.style.background  = '';

  document.getElementById('mud_neto').textContent        = '$ ' + fmt(honorNeto);
  document.getElementById('mud_iva').textContent         = mudTieneFactura ? '$ ' + fmt(iva) : '— Sin factura';
  document.getElementById('mud_bruto').textContent       = '$ ' + fmt(bruto);
  document.getElementById('mud_gastos_total').textContent = '$ ' + fmt(totalGastos);
  document.getElementById('mud_neto_final').textContent  = '$ ' + fmt(netofinal);

  const items = [
    `USD ${usd} × TC ${tc} = $${fmt(honorNeto)}`,
    mudTieneFactura ? `IVA 21%: $${fmt(iva)}` : `Sin factura (sin IVA)`,
    `Precinto: $${fmt(precinto)}`,
    `Fiscal: $${fmt(fiscal)}`,
    digitalizacion > 0 ? `Digitalización: $${fmt(digitalizacion)}` : null,
    `Ramiro: USD ${ramiroUsd} × TC ${tc} = $${fmt(gastoRamiro)}`,
    otros > 0 ? `Otros: $${fmt(otros)}` : null,
    vencResidencia ? `Residencia: ${estRes.label}` : null
  ].filter(Boolean);
  document.getElementById('mud_desglose').innerHTML = items.map(i => `<span class="tag">${i}</span>`).join(' ');

  return { tc, usd, honorNeto, iva, bruto, totalGastos, netofinal, gastoRamiro, precinto, fiscal, digitalizacion, otros, ramiroUsd, tcFalta, tieneFactura: mudTieneFactura, vencimientoResidencia: vencResidencia, residenciaCancelada };
};

window.guardarMudanza = async function(){
  const cliente = document.getElementById('mud_cliente').value.trim().toUpperCase();
  const clienteFinal = document.getElementById('mud_cliente_final').value.trim().toUpperCase();
  const destinacion = document.getElementById('mud_destinacion').value.trim().toUpperCase();
  const fecha   = document.getElementById('mud_fecha').value;
  const tcVal   = parseFloat(document.getElementById('mud_tc').value);
  if(!tcVal || tcVal <= 0){
    toast('⚠️ Falta el TC de la mudanza — es obligatorio para guardar');
    document.getElementById('mud_tc').focus();
    return;
  }
  if(!cliente){ toast('Ingresá el cliente'); return; }
  if(!fecha)  { toast('Ingresá la fecha'); return; }

  const vals = recalcMudanza();
  const mud = {
    fecha, cliente, clienteFinal, destinacion,
    tc: vals.tc,
    valorUsd: vals.usd,
    honorNeto: vals.honorNeto,
    iva: vals.iva,
    bruto: vals.bruto,
    precinto: vals.precinto,
    fiscal: vals.fiscal,
    digitalizacion: vals.digitalizacion,
    ramiroUsd: vals.ramiroUsd,
    gastoRamiro: vals.gastoRamiro,
    otros: vals.otros,
    totalGastos: vals.totalGastos,
    netoFinal: vals.netofinal,
    tieneFactura: vals.tieneFactura,
    vencimientoResidencia: vals.vencimientoResidencia || '',
    residenciaCancelada: !!vals.residenciaCancelada,
    ramiroPagado: document.getElementById('mud_ramiro_pagado').value,
    cobrado: document.getElementById('mud_cobrado').value === 'si',
    obs: document.getElementById('mud_obs').value.trim(),
    cargadoPor: user.username,
    ts: Date.now()
  };

  try {
    await addDoc(collection(db,'corresponsales_mudanzas'), mud);
    toast('✅ Mudanza guardada');
    limpiarMudanza();
  } catch(e){
    toast('❌ Error: ' + e.message);
  }
};

window.limpiarMudanza = function(){
  document.getElementById('mud_cliente').value = '';
  document.getElementById('mud_cliente_final').value = '';
  document.getElementById('mud_destinacion').value = '';
  document.getElementById('mud_valor_usd').value = '';
  document.getElementById('mud_precinto').value = '0';
  document.getElementById('mud_fiscal').value = '0';
  document.getElementById('mud_digitalizacion').value = '0';
  document.getElementById('mud_ramiro').value = '190';
  document.getElementById('mud_otros').value = '0';
  document.getElementById('mud_obs').value = '';
  document.getElementById('mud_ramiro_pagado').value = 'no';
  document.getElementById('mud_cobrado').value = 'no';
  document.getElementById('mud_tc').value = '';
  document.getElementById('mud_tiene_factura').value = 'si';
  document.getElementById('mud_venc_residencia').value = '';
  document.getElementById('mud_residencia_cancelada').value = 'no';
  recalcMudanza();
};

window.eliminarMudanza = async function(id){
  if(!confirm('¿Eliminar esta mudanza?')) return;
  await deleteDoc(doc(db,'corresponsales_mudanzas',id));
  toast('Mudanza eliminada');
};

// ── EDITAR MUDANZA ──
let mudanzaEditandoId = null;

window.editarMudanza = function(id){
  const m = mudanzas.find(x => x.id === id);
  if(!m) return;
  mudanzaEditandoId = id;

  document.getElementById('mud_fecha').value       = m.fecha || '';
  document.getElementById('mud_cliente').value     = m.cliente || '';
  document.getElementById('mud_cliente_final').value = m.clienteFinal || '';
  document.getElementById('mud_destinacion').value = m.destinacion || '';
  document.getElementById('mud_tc').value          = m.tc || 1440;
  document.getElementById('mud_valor_usd').value    = m.valorUsd || '';
  document.getElementById('mud_precinto').value    = m.precinto || 0;
  document.getElementById('mud_fiscal').value      = m.fiscal || 0;
  document.getElementById('mud_digitalizacion').value = m.digitalizacion || 0;
  document.getElementById('mud_ramiro').value      = m.ramiroUsd || 190;
  document.getElementById('mud_otros').value       = m.otros || 0;
  document.getElementById('mud_obs').value         = m.obs || '';
  document.getElementById('mud_ramiro_pagado').value = m.ramiroPagado || 'no';
  document.getElementById('mud_cobrado').value     = m.cobrado ? 'si' : 'no';
  document.getElementById('mud_tiene_factura').value = m.tieneFactura === false ? 'no' : 'si';
  document.getElementById('mud_venc_residencia').value = m.vencimientoResidencia || '';
  document.getElementById('mud_residencia_cancelada').value = m.residenciaCancelada ? 'si' : 'no';

  // Cambiar título y botones del formulario
  document.getElementById('mud-form-titulo').textContent = '✏️ Editando mudanza: ' + m.cliente;
  document.getElementById('mud-btn-guardar').style.display  = 'none';
  document.getElementById('mud-btn-actualizar').style.display = 'inline-flex';
  document.getElementById('mud-btn-cancelar').style.display   = 'inline-flex';

  // Scroll al formulario
  document.getElementById('tab-mudanzas').scrollIntoView({behavior:'smooth'});
  recalcMudanza();
  toast('✏️ Mudanza cargada para editar');
};

window.actualizarMudanza = async function(){
  if(!mudanzaEditandoId) return;
  const cliente = document.getElementById('mud_cliente').value.trim().toUpperCase();
  const clienteFinal = document.getElementById('mud_cliente_final').value.trim().toUpperCase();
  const destinacion = document.getElementById('mud_destinacion').value.trim().toUpperCase();
  const fecha   = document.getElementById('mud_fecha').value;
  const tcVal   = parseFloat(document.getElementById('mud_tc').value);
  if(!tcVal || tcVal <= 0){
    toast('⚠️ Falta el TC de la mudanza — es obligatorio para guardar');
    document.getElementById('mud_tc').focus();
    return;
  }
  if(!cliente){ toast('Ingresá el cliente'); return; }
  if(!fecha)  { toast('Ingresá la fecha');   return; }

  const vals = recalcMudanza();
  const datos = {
    fecha, cliente, clienteFinal, destinacion,
    tc: vals.tc,
    valorUsd: vals.usd,
    honorNeto: vals.honorNeto,
    iva: vals.iva,
    bruto: vals.bruto,
    precinto: vals.precinto,
    fiscal: vals.fiscal,
    digitalizacion: vals.digitalizacion,
    ramiroUsd: vals.ramiroUsd,
    gastoRamiro: vals.gastoRamiro,
    otros: vals.otros,
    totalGastos: vals.totalGastos,
    netoFinal: vals.netofinal,
    tieneFactura: vals.tieneFactura,
    vencimientoResidencia: vals.vencimientoResidencia || '',
    residenciaCancelada: !!vals.residenciaCancelada,
    ramiroPagado: document.getElementById('mud_ramiro_pagado').value,
    cobrado: document.getElementById('mud_cobrado').value === 'si',
    obs: document.getElementById('mud_obs').value.trim(),
    modificadoPor: user.username,
    tsEdit: Date.now()
  };

  try {
    await updateDoc(doc(db,'corresponsales_mudanzas', mudanzaEditandoId), datos);
    toast('✅ Mudanza actualizada');
    cancelarEdicionMudanza();
  } catch(e){
    toast('❌ Error: ' + e.message);
  }
};

window.cancelarEdicionMudanza = function(){
  mudanzaEditandoId = null;
  document.getElementById('mud-form-titulo').textContent = '📦 Nueva mudanza';
  document.getElementById('mud-btn-guardar').style.display    = 'inline-flex';
  document.getElementById('mud-btn-actualizar').style.display = 'none';
  document.getElementById('mud-btn-cancelar').style.display   = 'none';
  limpiarMudanza();
};

// Paginación del listado de mudanzas
let mudanzasPage = 1;
const MUDANZAS_PAGE_SIZE = 15;

window.resetPaginaMudanzas = function(){
  mudanzasPage = 1;
  renderMudanzas();
};

window.cambiarPaginaMudanzas = function(delta){
  mudanzasPage += delta;
  renderMudanzas();
};

function renderFiltrosMudanzas(){
  const cliSel = document.getElementById('mud_filtro_cliente');
  if(!cliSel) return;
  const v = cliSel.value;
  const nombres = [...new Set(mudanzas.map(m => m.cliente).filter(Boolean))].sort();
  cliSel.innerHTML = '<option value="">Todos los clientes</option>' +
    nombres.map(n => `<option value="${n}">${n}</option>`).join('');
  cliSel.value = v;

  const mesSel = document.getElementById('mud_filtro_mes');
  if(mesSel){
    const vm = mesSel.value;
    const meses = [...new Set(mudanzas.map(m => m.fecha?.slice(0,7)).filter(Boolean))].sort().reverse();
    mesSel.innerHTML = '<option value="">Todos los meses</option>' +
      meses.map(m => `<option value="${m}">${m}</option>`).join('');
    mesSel.value = vm;
  }
}

function filtrarMudanzas(){
  const filtCliente = document.getElementById('mud_filtro_cliente')?.value || '';
  const filtMes     = document.getElementById('mud_filtro_mes')?.value || '';
  const filtDesde   = document.getElementById('mud_filtro_fecha_desde')?.value || '';
  const filtHasta   = document.getElementById('mud_filtro_fecha_hasta')?.value || '';
  let out = [...mudanzas];
  if(filtCliente) out = out.filter(m => m.cliente === filtCliente);
  if(filtMes)      out = out.filter(m => m.fecha && m.fecha.startsWith(filtMes));
  if(filtDesde)    out = out.filter(m => (m.fecha||'') >= filtDesde);
  if(filtHasta)    out = out.filter(m => (m.fecha||'') <= filtHasta);
  // Más nueva primero: la última mudanza cargada arriba de todo, y así hacia atrás.
  out.sort((a,b) => (b.fecha||'').localeCompare(a.fecha||'') || (b.ts||0)-(a.ts||0));
  return out;
}
window.filtrarMudanzas = filtrarMudanzas;

function renderMudanzas(){
  renderFiltrosMudanzas();
  const tbody = document.getElementById('tbody-mudanzas');
  const tfoot = document.getElementById('tfoot-mudanzas');
  const todas = filtrarMudanzas();

  if(!todas.length){
    tbody.innerHTML = '<tr><td colspan="16" style="text-align:center;color:#94a3b8;padding:24px;">Sin mudanzas registradas</td></tr>';
    if(tfoot) tfoot.innerHTML = '';
    document.getElementById('mudanzas-paginacion').innerHTML = '';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(todas.length / MUDANZAS_PAGE_SIZE));
  if(mudanzasPage > totalPaginas) mudanzasPage = totalPaginas;
  if(mudanzasPage < 1) mudanzasPage = 1;
  const inicio = (mudanzasPage - 1) * MUDANZAS_PAGE_SIZE;
  const pagina = todas.slice(inicio, inicio + MUDANZAS_PAGE_SIZE);

  tbody.innerHTML = pagina.map(m => {
    const estRes = estadoResidencia(m);
    return `
    <tr>
      <td>${m.fecha||''}</td>
      <td><strong>${m.cliente||''}</strong></td>
      <td><strong style="background:${estRes.bg};color:${estRes.color};padding:2px 8px;border-radius:6px;" title="Residencia: ${estRes.label}">${m.clienteFinal||'-'}</strong></td>
      <td class="mono">${m.destinacion||'-'}</td>
      <td class="mono">${m.tc||''}</td>
      <td class="mono">${m.valorUsd||''}</td>
      <td style="color:#1e3a8a;font-weight:600;">$${fmt(m.honorNeto)}</td>
      <td>${m.tieneFactura === false ? '— s/fact' : '$'+fmt(m.iva)}</td>
      <td style="font-weight:700;">$${fmt(m.bruto)}</td>
      <td style="color:#dc2626;">$${fmt(m.totalGastos)}</td>
      <td style="color:#059669;font-weight:700;">$${fmt(m.netoFinal)}</td>
      <td>${m.cobrado
        ? '<span class="tag" style="background:#dcfce7;color:#166534;">✅ Cobrado</span>'
        : '<span class="tag" style="background:#fee2e2;color:#991b1b;">❌ Sin cobrar</span>'}</td>
      <td>${m.ramiroPagado === 'si'
        ? '<span class="tag" style="background:#dcfce7;color:#166534;">✅ Pagado</span>'
        : '<span class="tag" style="background:#fee2e2;color:#991b1b;">❌ Pendiente</span>'}</td>
      <td><span class="tag" style="background:${estRes.bg};color:${estRes.color};">${m.vencimientoResidencia ? m.vencimientoResidencia+' · ' : ''}${estRes.label}</span></td>
      <td style="font-size:11px;color:#64748b;">${m.obs||''}</td>
      <td style="display:flex;gap:6px;">
        <button class="btn-outline" style="padding:4px 10px;font-size:12px;" onclick="editarMudanza('${m.id}')">✏️ Editar</button>
        <button class="btn-danger" onclick="eliminarMudanza('${m.id}')">✕</button>
      </td>
    </tr>
  `;
  }).join('');

  if(tfoot){
    const totUsd    = todas.reduce((a,b)=>a+(b.valorUsd||0),0);
    const totNeto   = todas.reduce((a,b)=>a+(b.honorNeto||0),0);
    const totIva    = todas.reduce((a,b)=>a+(b.iva||0),0);
    const totBruto  = todas.reduce((a,b)=>a+(b.bruto||0),0);
    const totGastos = todas.reduce((a,b)=>a+(b.totalGastos||0),0);
    const totQueda  = todas.reduce((a,b)=>a+(b.netoFinal||0),0);
    tfoot.innerHTML = `
      <tr style="background:#f0f4f8;font-weight:700;border-top:2px solid #1e3a8a;">
        <td colspan="5">TOTAL (${todas.length} mudanzas)</td>
        <td class="mono">${totUsd.toFixed(2)}</td>
        <td style="color:#1e3a8a;">$${fmt(totNeto)}</td>
        <td>$${fmt(totIva)}</td>
        <td style="color:#059669;">$${fmt(totBruto)}</td>
        <td style="color:#dc2626;">$${fmt(totGastos)}</td>
        <td style="color:#059669;">$${fmt(totQueda)}</td>
        <td colspan="5"></td>
      </tr>`;
  }

  document.getElementById('mudanzas-paginacion').innerHTML = `
    <div class="pagin-bar">
      <button onclick="cambiarPaginaMudanzas(-1)" ${mudanzasPage<=1?'disabled':''}>‹ Anterior</button>
      <span>${mudanzasPage}/${totalPaginas}</span>
      <button onclick="cambiarPaginaMudanzas(1)" ${mudanzasPage>=totalPaginas?'disabled':''}>Siguiente ›</button>
    </div>`;
}

window.exportarMudanzas = function(){
  const todas = filtrarMudanzas();
  if(!todas.length){ toast('No hay mudanzas para exportar con esos filtros'); return; }

  const fmtFechaAR = (iso) => {
    if(!iso) return '';
    const [y,m,d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };
  const dec2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  const header = ['FECHA','CLIENTE','CLIENTE FINAL','DESTINACIÓN','TC','USD','HONOR. NETO','IVA','BRUTO','GASTOS','NOS QUEDA','COBRADO','RAMIRO PAGADO','FACTURA','VENC. RESIDENCIA','ESTADO RESIDENCIA','OBS'];

  const ordenadas = [...todas].sort((a,b) => (a.fecha||'').localeCompare(b.fecha||''));

  const rows = ordenadas.map(m => {
    const estRes = estadoResidencia(m);
    return [
      fmtFechaAR(m.fecha), m.cliente||'', m.clienteFinal||'', m.destinacion||'',
      m.tc||'', m.valorUsd||'',
      dec2(m.honorNeto), dec2(m.iva), dec2(m.bruto), dec2(m.totalGastos), dec2(m.netoFinal),
      m.cobrado ? 'SI' : 'NO',
      m.ramiroPagado === 'si' ? 'SI' : 'NO',
      m.tieneFactura === false ? 'NO' : 'SI',
      m.vencimientoResidencia ? fmtFechaAR(m.vencimientoResidencia) : '',
      estRes.label,
      m.obs || ''
    ];
  });

  const totNeto   = todas.reduce((a,b)=>a+(b.honorNeto||0),0);
  const totIva    = todas.reduce((a,b)=>a+(b.iva||0),0);
  const totBruto  = todas.reduce((a,b)=>a+(b.bruto||0),0);
  const totGastos = todas.reduce((a,b)=>a+(b.totalGastos||0),0);
  const totQueda  = todas.reduce((a,b)=>a+(b.netoFinal||0),0);

  const totalRow = ['TOTAL', `${todas.length} mudanza(s)`, '', '', '', '', dec2(totNeto), dec2(totIva), dec2(totBruto), dec2(totGastos), dec2(totQueda), '', '', '', '', '', ''];

  const aoa = [header, ...rows, totalRow];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);

  ws['!cols'] = [
    {wch:11},{wch:20},{wch:20},{wch:16},{wch:8},{wch:8},
    {wch:13},{wch:12},{wch:13},{wch:12},{wch:13},{wch:9},{wch:12},{wch:9},{wch:13},{wch:14},{wch:28}
  ];

  const lastCol = XLSX.utils.encode_col(header.length - 1);
  ws['!autofilter'] = { ref: `A1:${lastCol}1` };

  // ── TOTAL con fórmula SUBTOTAL: al filtrar en Excel (autofiltro), estas celdas
  // recalculan solas y muestran la suma SOLO de las filas visibles/filtradas ──
  {
    const totalRowNum  = 2 + rows.length; // fila Excel (1-indexed) de la fila TOTAL
    const firstDataRow = 2;
    const lastDataRow  = 1 + rows.length;
    [6,7,8,9,10].forEach(c => { // HONOR. NETO, IVA, BRUTO, GASTOS, NOS QUEDA
      const colLetter = XLSX.utils.encode_col(c);
      const addr = XLSX.utils.encode_cell({ r: totalRowNum - 1, c });
      ws[addr] = { t:'n', v: totalRow[c], f: `SUBTOTAL(109,${colLetter}${firstDataRow}:${colLetter}${lastDataRow})` };
    });
  }

  const finoGris  = { style: 'thin', color: { rgb: 'B8C2CC' } };
  const bordeTodo = { top: finoGris, bottom: finoGris, left: finoGris, right: finoGris };
  const colsNumericas = [4,5,6,7,8,9,10];
  const colsDecimal2  = [6,7,8,9,10];
  const formatoDecimal = '#,##0.00';
  const totalRowIdx = 1 + rows.length;

  const range = XLSX.utils.decode_range(ws['!ref']);
  for(let R = range.s.r; R <= range.e.r; R++){
    for(let C = range.s.c; C <= range.e.c; C++){
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if(!ws[addr]) ws[addr] = { t: 's', v: '' };

      if(R > 0 && R !== totalRowIdx && colsDecimal2.includes(C) && typeof ws[addr].v === 'number'){
        ws[addr].z = formatoDecimal;
      }

      if(R === 0){
        ws[addr].s = {
          font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '1E3A8A' } },
          border: bordeTodo,
          alignment: { horizontal: 'center', vertical: 'center' }
        };
      } else if(R === totalRowIdx){
        ws[addr].s = {
          font: { bold: true, sz: 11, color: { rgb: 'DC2626' } },
          fill: { fgColor: { rgb: 'FEF2F2' } },
          border: bordeTodo,
          alignment: { horizontal: colsNumericas.includes(C) ? 'right' : 'left' },
          numFmt: colsDecimal2.includes(C) ? formatoDecimal : undefined
        };
      } else {
        ws[addr].s = {
          font: { sz: 10 },
          border: bordeTodo,
          alignment: { horizontal: colsNumericas.includes(C) ? 'right' : 'left' },
          numFmt: colsDecimal2.includes(C) ? formatoDecimal : undefined
        };
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Mudanzas');

  const filtCliente = document.getElementById('mud_filtro_cliente')?.value || 'todos';
  const filtMes     = document.getElementById('mud_filtro_mes')?.value || 'todos';
  const nombreArchivo = `mudanzas_${filtCliente}_${filtMes}.xlsx`.replace(/\s+/g,'_');

  XLSX.writeFile(wb, nombreArchivo);
};

// ── CUENTA RAMIRO ──
window.renderRamiro = function(){
  const filtEstado = document.getElementById('ramiro_filtro_estado')?.value || '';
  const filtMes     = document.getElementById('ramiro_filtro_mes')?.value || '';
  const filtFecha   = document.getElementById('ramiro_filtro_fecha')?.value || '';
  const tc = 1440;

  const itemsTodos = [];

  operaciones.filter(o => o.esKotinya).forEach(o => {
    itemsTodos.push({
      tipo: 'Kotinya',
      fecha: o.fecha,
      cliente: o.cliente || '',
      detalle: o.destinacion || '',
      ramiroUsd: o.ramiroDeuda || 30,
      pesos: (o.ramiroDeuda || 30) * (o.tc || tc),
      estado: o.ramiroOPagado || 'no',
      cobrado: true, // las operaciones normales no dependen de "cobrado", solo las mudanzas
      id: o.id,
      col: 'ops'
    });
  });

  mudanzas.forEach(m => {
    itemsTodos.push({
      tipo: 'Mudanza',
      fecha: m.fecha,
      cliente: m.cliente || '',
      detalle: m.obs || '',
      ramiroUsd: m.ramiroUsd || 190,
      pesos: m.gastoRamiro || (m.ramiroUsd || 190) * (m.tc || tc),
      estado: m.ramiroPagado || 'no',
      cobrado: !!m.cobrado,
      id: m.id,
      col: 'mudanzas'
    });
  });

  itemsTodos.sort((a,b) => a.fecha > b.fecha ? -1 : 1);

  // Poblar el selector de meses en base a todos los registros
  const selMes = document.getElementById('ramiro_filtro_mes');
  if(selMes){
    const vActual = selMes.value;
    const meses = [...new Set(itemsTodos.map(i => i.fecha?.slice(0,7)).filter(Boolean))].sort().reverse();
    selMes.innerHTML = '<option value="">Todos los meses</option>' +
      meses.map(m => `<option value="${m}">${m}</option>`).join('');
    selMes.value = vActual;
  }

  let items = [...itemsTodos];
  if(filtMes)   items = items.filter(i => i.fecha && i.fecha.startsWith(filtMes));
  if(filtFecha) items = items.filter(i => i.fecha === filtFecha);

  const filtrados = filtEstado ? items.filter(i => i.estado === filtEstado) : items;

  const totalUsd      = items.reduce((a,b) => a + b.ramiroUsd, 0);
  const totalPesos    = items.reduce((a,b) => a + b.pesos, 0);
  const pendienteUsd  = items.filter(i => i.estado === 'no').reduce((a,b) => a + b.ramiroUsd, 0);
  const pagadoUsd     = items.filter(i => i.estado === 'si').reduce((a,b) => a + b.ramiroUsd, 0);
  const pagadoPesos   = items.filter(i => i.estado === 'si').reduce((a,b) => a + b.pesos, 0);
  const pendientePesos = items.filter(i => i.estado === 'no').reduce((a,b) => a + b.pesos, 0);

  document.getElementById('ramiro-kpis').innerHTML = `
    <div class="kpi" style="border-color:#fca5a5;background:#fef2f2;">
      <div class="kpi-label">Total a pagar (histórico)</div>
      <div class="kpi-val" style="color:#dc2626;">$${fmt(totalPesos)}</div>
      <div class="kpi-sub">≈ USD ${fmt(totalUsd)}</div>
    </div>
    <div class="kpi" style="border-color:#fca5a5;background:#fef2f2;">
      <div class="kpi-label">⚠️ Pendiente de pago</div>
      <div class="kpi-val" style="color:#dc2626;">$${fmt(pendientePesos)}</div>
      <div class="kpi-sub">≈ USD ${fmt(pendienteUsd)}</div>
    </div>
    <div class="kpi" style="border-color:#86efac;background:#f0fdf4;">
      <div class="kpi-label">✅ Ya pagado</div>
      <div class="kpi-val" style="color:#059669;">$${fmt(pagadoPesos)}</div>
      <div class="kpi-sub">≈ USD ${fmt(pagadoUsd)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Mudanzas</div>
      <div class="kpi-val">${items.filter(i=>i.tipo==='Mudanza').length}</div>
      <div class="kpi-sub">Kotinya: ${items.filter(i=>i.tipo==='Kotinya').length}</div>
    </div>
  `;

  const tbodyRamiro = document.getElementById('tbody-ramiro');
  const ramiroPaginacionEl = document.getElementById('ramiro-paginacion');

  if(!filtrados.length){
    tbodyRamiro.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">Sin registros</td></tr>';
    if(ramiroPaginacionEl) ramiroPaginacionEl.innerHTML = '';
    return;
  }

  // filtrados ya viene ordenado del más nuevo al más viejo (itemsTodos se ordena por fecha desc)
  const { pagina, page, totalPaginas } = paginarArray('ramiro', filtrados, PAGE_SIZE_GENERICO);

  tbodyRamiro.innerHTML = pagina.map(i => `
      <tr>
        <td><span class="tag" style="${i.tipo==='Kotinya'?'background:#fef9c3;color:#92400e':'background:#dbeafe;color:#1e3a8a'}">${i.tipo}</span></td>
        <td>${i.fecha||''}</td>
        <td><strong>${i.cliente}</strong></td>
        <td style="font-size:12px;color:#64748b;">${i.detalle}</td>
        <td style="font-weight:700;color:#dc2626;">USD ${i.ramiroUsd}</td>
        <td>$${fmt(i.pesos)}</td>
        <td>
          ${i.estado === 'si'
            ? '<span class="tag" style="background:#dcfce7;color:#166534;">✅ Pagado</span>'
            : '<span class="tag" style="background:#fee2e2;color:#991b1b;">❌ Pendiente</span>'}
        </td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          ${i.estado === 'no'
            ? (i.col === 'mudanzas' && !i.cobrado
                ? '<span class="tag" style="background:#fee2e2;color:#991b1b;">⏳ Sin cobrar</span>'
                : `<button class="btn-success" style="font-size:11px;padding:4px 10px;" onclick="pagarRamiroItem('${i.id}','${i.col}')">Marcar pagado</button>`)
            : `<button class="btn-outline" style="font-size:11px;padding:4px 10px;" onclick="editarRamiroItem('${i.id}','${i.col}')">✏️ Editar</button>`}
          <button class="btn-danger" onclick="eliminarRamiroItem('${i.id}','${i.col}','${i.tipo}')">🗑</button>
        </td>
      </tr>
    `).join('');

  if(ramiroPaginacionEl) ramiroPaginacionEl.innerHTML = htmlPaginacionGenerica(page, totalPaginas, 'ramiro');
};

// ── EDITAR (revertir a pendiente) un item de Ramiro por si se marcó pagado por error ──
window.editarRamiroItem = async function(id, col){
  if(!confirm('¿Volver a marcar este pago de Ramiro como PENDIENTE?')) return;
  const colName = col === 'ops' ? 'despachantees_ops' : 'corresponsales_mudanzas';
  const campo   = col === 'ops' ? 'ramiroOPagado' : 'ramiroPagado';
  await updateDoc(doc(db, colName, id), { [campo]: 'no' });
  toast('↩️ Revertido a pendiente');
};

// ── ELIMINAR un item de Ramiro ──
// Si es Kotinya (col='ops') elimina la operación completa (así se cargó la deuda a Ramiro).
// Si es Mudanza (col='mudanzas') elimina la mudanza completa.
window.eliminarRamiroItem = async function(id, col, tipo){
  const msg = tipo === 'Mudanza'
    ? '¿Eliminar esta mudanza? Se borra el registro completo, no solo la deuda de Ramiro.'
    : '¿Eliminar esta operación Kotinya? Se borra el registro completo, no solo la deuda de Ramiro.';
  if(!confirm(msg)) return;
  const colName = col === 'ops' ? 'despachantees_ops' : 'corresponsales_mudanzas';
  await deleteDoc(doc(db, colName, id));
  toast('Registro eliminado');
};

window.pagarRamiroItem = async function(id, col){
  const colName = col === 'ops' ? 'despachantees_ops' : 'corresponsales_mudanzas';
  const campo   = col === 'ops' ? 'ramiroOPagado' : 'ramiroPagado';
  await updateDoc(doc(db, colName, id), { [campo]: 'si' });
  toast('✅ Marcado como pagado');
};

window.marcarTodoPagadoRamiro = async function(){
  if(!confirm('¿Marcar TODOS los pendientes como pagados a Ramiro? (Solo se marcarán mudanzas ya cobradas)')) return;
  const pending = [
    ...operaciones.filter(o => o.esKotinya && o.ramiroOPagado !== 'si').map(o => ({id:o.id, col:'despachantees_ops', campo:'ramiroOPagado'})),
    ...mudanzas.filter(m => m.ramiroPagado !== 'si' && m.cobrado).map(m => ({id:m.id, col:'corresponsales_mudanzas', campo:'ramiroPagado'}))
  ];
  for(const p of pending){
    await updateDoc(doc(db, p.col, p.id), { [p.campo]: 'si' });
  }
  toast(`✅ ${pending.length} registros marcados como pagados`);
};

// ── RECIBOS ──
// Datos de la empresa para el membrete del recibo.
// ⚠️ No pude confirmar la dirección/CUIT exactos buscando en la web (el sitio no aparece bien
// indexado). Completá o corregí estos datos si hace falta, quedaron todos juntos acá:
const EMPRESA_REMITO = {
  nombre: 'GLOBALCOMINT SAS',
  subtitulo: 'Despachante de Aduana',
  direccion: 'Mendoza, Argentina', // TODO: confirmar (Ej: PTM Of. 14 / Puerto Seco Of. A4)
  telefono: '261 701-6488',
  cuit: '30-71614367-4'
};

let remitos = [];
let remitoSeleccionadas = new Set();

onSnapshot(collection(db,'despachantees_remitos'), snap => {
  remitos = snap.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b) => (b.numero||0)-(a.numero||0));
  renderHistorialRemitos();
});

function poblarSelectRemitoDespachante(){
  const sel = document.getElementById('remito_despachante');
  if(!sel) return;
  const v = sel.value;
  const nombres = [...new Set(clientes.map(c => c.nombre))].sort();
  sel.innerHTML = '<option value="">Seleccioná un despachante...</option>' +
    nombres.map(n => `<option value="${n}">${n}</option>`).join('');
  sel.value = v;
}

window.renderRemitos = function(){
  poblarSelectRemitoDespachante();
  const desp = document.getElementById('remito_despachante').value;
  const desde = document.getElementById('remito_fecha_desde').value;
  const hasta = document.getElementById('remito_fecha_hasta').value;
  const filtroEstado = document.getElementById('remito_filtro_estado').value;
  const card = document.getElementById('remito-lista-card');

  if(!desp){
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  document.getElementById('remito-desp-nombre').textContent = desp;

  let ops = operaciones.filter(o => o.despachante === desp);
  if(desde) ops = ops.filter(o => (o.fecha||'') >= desde);
  if(hasta) ops = ops.filter(o => (o.fecha||'') <= hasta);
  if(filtroEstado === 'sin_remito') ops = ops.filter(o => !o.numRemito);
  ops = ops.sort((a,b) => (a.fecha||'').localeCompare(b.fecha||''));

  // Limpiar selección de operaciones que ya no están visibles con estos filtros
  const idsVisibles = new Set(ops.map(o => o.id));
  [...remitoSeleccionadas].forEach(id => { if(!idsVisibles.has(id)) remitoSeleccionadas.delete(id); });

  const tbody = document.getElementById('tbody-remito-ops');
  if(!ops.length){
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px;">Sin operaciones con esos filtros</td></tr>';
  } else {
    tbody.innerHTML = ops.map(o => `
      <tr>
        <td><input type="checkbox" ${remitoSeleccionadas.has(o.id)?'checked':''} onchange="toggleRemitoOp('${o.id}', this.checked)"></td>
        <td>${o.fecha||''}</td>
        <td>${o.cliente||'-'}</td>
        <td class="mono">${o.destinacion||'-'}</td>
        <td>${(o.tipo==='MIC'||o.tipo==='MULTINOTA'||o.tipo==='ADICIONALES') ? '-' : `<span class="canal-badge canal-${o.canal||'V'}">${o.canal||'V'}</span>`}</td>
        <td style="font-weight:700;color:#059669;">$${fmt2(o.bruto)}</td>
        <td>${o.numRemito ? `<span class="tag" style="background:#fef9c3;color:#92400e;">N° ${o.numRemito}</span>` : '<span class="tag" style="background:#f1f5f9;color:#64748b;">Sin recibo</span>'}</td>
      </tr>
    `).join('');
  }

  document.getElementById('remito_chk_todas').checked = ops.length > 0 && ops.every(o => remitoSeleccionadas.has(o.id));
  actualizarTotalRemito();
};

window.toggleRemitoOp = function(id, checked){
  if(checked) remitoSeleccionadas.add(id);
  else remitoSeleccionadas.delete(id);
  actualizarTotalRemito();
};

window.toggleRemitoTodas = function(checked){
  const desp = document.getElementById('remito_despachante').value;
  const desde = document.getElementById('remito_fecha_desde').value;
  const hasta = document.getElementById('remito_fecha_hasta').value;
  const filtroEstado = document.getElementById('remito_filtro_estado').value;
  let ops = operaciones.filter(o => o.despachante === desp);
  if(desde) ops = ops.filter(o => (o.fecha||'') >= desde);
  if(hasta) ops = ops.filter(o => (o.fecha||'') <= hasta);
  if(filtroEstado === 'sin_remito') ops = ops.filter(o => !o.numRemito);
  ops.forEach(o => { if(checked) remitoSeleccionadas.add(o.id); else remitoSeleccionadas.delete(o.id); });
  renderRemitos();
};

function actualizarTotalRemito(){
  const seleccionadas = operaciones.filter(o => remitoSeleccionadas.has(o.id));
  const total = seleccionadas.reduce((a,b) => a + (b.bruto||0), 0);
  document.getElementById('remito-total-sel').textContent =
    seleccionadas.length ? `${seleccionadas.length} operación(es) seleccionada(s) — Total $${fmt2(total)}` : 'Ninguna operación seleccionada';
}

function renderHistorialRemitos(){
  const tbody = document.getElementById('tbody-remitos-hist');
  const paginacionEl = document.getElementById('remitos-paginacion');
  if(!tbody) return;
  if(!remitos.length){
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:16px;">Sin recibos emitidos</td></tr>';
    if(paginacionEl) paginacionEl.innerHTML = '';
    return;
  }
  // remitos ya viene ordenado del más nuevo al más viejo (sort por numero desc al cargar)
  const { pagina, page, totalPaginas } = paginarArray('remitosHist', remitos, PAGE_SIZE_GENERICO);
  tbody.innerHTML = pagina.map(r => `
    <tr>
      <td class="mono">${r.numero||''}</td>
      <td>${r.fecha||''}</td>
      <td><strong>${r.despachante||''}</strong></td>
      <td style="text-align:center;">${(r.ops||[]).length}</td>
      <td style="font-weight:700;color:#059669;">$${fmt2(r.total)}</td>
      <td><button class="btn-outline" style="padding:4px 10px;font-size:12px;" onclick="reimprimirRemito('${r.id}')">🖨️ Reimprimir</button> <button class="btn-danger" onclick="eliminarRecibo('${r.id}')">✕</button></td>
    </tr>
  `).join('');
  if(paginacionEl) paginacionEl.innerHTML = htmlPaginacionGenerica(page, totalPaginas, 'remitosHist');
}

function construirHtmlRemito(numero, despachante, fecha, opsData, total){
  const filas = opsData.map(o => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${o.fecha||''}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${o.cliente||'-'}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-family:monospace;">${o.destinacion||'-'}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;">${o.canal||'-'}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;font-family:monospace;">${o.tc||'-'}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;">${o.obs||'-'}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">$${fmt2(o.bruto)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Recibo N° ${numero} - ${despachante}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
  *{box-sizing:border-box;}
  body{font-family:'DM Sans',sans-serif;color:#1e293b;padding:40px;max-width:800px;margin:0 auto;}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1e3a8a;padding-bottom:16px;margin-bottom:24px;}
  .empresa-nombre{font-size:22px;font-weight:700;color:#1e3a8a;}
  .empresa-sub{font-size:12px;color:#64748b;margin-top:2px;}
  .empresa-datos{font-size:11px;color:#64748b;margin-top:6px;line-height:1.5;}
  .recibo-titulo{text-align:right;}
  .recibo-titulo .tag{background:#eff6ff;color:#1e3a8a;font-weight:700;font-size:15px;padding:6px 16px;border-radius:8px;display:inline-block;}
  .recibo-num{font-size:12px;color:#64748b;margin-top:6px;}
  .datos-recibo{display:flex;justify-content:space-between;margin-bottom:20px;font-size:13px;}
  table{width:100%;border-collapse:collapse;margin-top:10px;}
  thead tr{background:#1e3a8a;color:#fff;}
  th{padding:8px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.3px;}
  .total-row{font-weight:700;font-size:15px;color:#1e3a8a;}
  .firma-box{display:flex;justify-content:space-between;margin-top:60px;}
  .firma{width:220px;border-top:1px solid #94a3b8;text-align:center;padding-top:6px;font-size:11px;color:#64748b;}
  @media print{ body{padding:20px;} }
</style></head>
<body>
  <div class="header">
    <div>
      <div class="empresa-nombre">${EMPRESA_REMITO.nombre}</div>
      <div class="empresa-sub">${EMPRESA_REMITO.subtitulo}</div>
      <div class="empresa-datos">
        ${EMPRESA_REMITO.direccion}<br>
        Tel: ${EMPRESA_REMITO.telefono}${EMPRESA_REMITO.cuit ? '<br>CUIT: '+EMPRESA_REMITO.cuit : ''}
      </div>
    </div>
    <div class="recibo-titulo">
      <span class="tag">RECIBO</span>
      <div class="recibo-num">N° ${String(numero).padStart(5,'0')}</div>
    </div>
  </div>

  <div class="datos-recibo">
    <div><strong>Despachante:</strong> ${despachante}</div>
    <div><strong>Fecha de emisión:</strong> ${fecha}</div>
  </div>

  <table>
    <thead>
      <tr><th>Fecha</th><th>Cliente</th><th>Destinación</th><th>Canal</th><th>TC</th><th>Obs</th><th style="text-align:right;">Valor $</th></tr>
    </thead>
    <tbody>${filas}</tbody>
    <tfoot>
      <tr class="total-row">
        <td colspan="6" style="padding:10px 8px;text-align:right;border-top:2px solid #1e3a8a;">TOTAL</td>
        <td style="padding:10px 8px;text-align:right;border-top:2px solid #1e3a8a;">$${fmt2(total)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="firma-box">
    <div class="firma">Recibí conforme</div>
    <div class="firma">Aclaración / DNI</div>
  </div>

  <script>window.onload = () => window.print();<\/script>
</body></html>`;
}

window.generarRemito = async function(){
  const despachante = document.getElementById('remito_despachante').value;
  if(!despachante){ toast('Seleccioná un despachante'); return; }
  const seleccionadas = operaciones.filter(o => remitoSeleccionadas.has(o.id));
  if(!seleccionadas.length){ toast('⚠️ Tildá al menos una operación'); return; }

  const numero = remitos.length + 1;
  const fechaHoy = new Date().toISOString().split('T')[0];
  const total = seleccionadas.reduce((a,b) => a + (b.bruto||0), 0);

  const opsData = seleccionadas
    .sort((a,b) => (a.fecha||'').localeCompare(b.fecha||''))
    .map(o => ({ id:o.id, fecha:o.fecha||'', cliente:o.cliente||'', destinacion:o.destinacion||'', canal:o.canal||'', tc:o.tc||'', obs:o.obs||'', bruto:o.bruto||0 }));

  try {
    await addDoc(collection(db,'despachantees_remitos'), {
      numero, despachante, fecha: fechaHoy, ops: opsData, total,
      generadoPor: user.username, ts: Date.now()
    });
    // Marca cada operación con el N° de recibo emitido
    for(const o of seleccionadas){
      await updateDoc(doc(db,'despachantees_ops', o.id), { numRemito: numero });
    }

    const html = construirHtmlRemito(numero, despachante, fechaHoy, opsData, total);
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();

    remitoSeleccionadas.clear();
    toast('✅ Recibo N° ' + numero + ' generado');
    renderRemitos();
  } catch(e){
    toast('❌ Error al generar el recibo: ' + e.message);
  }
};

window.reimprimirRemito = function(id){
  const r = remitos.find(x => x.id === id);
  if(!r) return;
  const html = construirHtmlRemito(r.numero, r.despachante, r.fecha, r.ops||[], r.total||0);
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
};

window.eliminarRecibo = async function(id){
  const r = remitos.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`¿Eliminar el recibo N° ${r.numero} de ${r.despachante}? Las operaciones incluidas quedarán marcadas como "Sin recibo" y se van a poder volver a incluir en uno nuevo.`)) return;
  try {
    for(const o of (r.ops||[])){
      await updateDoc(doc(db,'despachantees_ops', o.id), { numRemito: null });
    }
    await deleteDoc(doc(db,'despachantees_remitos', id));
    toast('Recibo eliminado');
    renderRemitos();
  } catch(e){
    toast('❌ Error al eliminar el recibo: ' + e.message);
  }
};

// ── INIT ──
recalcularFormulario();
recalcMudanza();
