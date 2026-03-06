// admin.js — Panel de Administración OECE
import { db } from './firebase-config.js';
import { requireAuth, logout } from './auth.js';
import {
  collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let session = null;

document.addEventListener('DOMContentLoaded', () => {
  session = requireAuth('admin');
  if (!session) return;
  initAdmin();
});

function initAdmin() {
  setupNav();
  loadDashboard();
  setupUsuariosTab();
  setupCargaTab();
}

// ── NAVEGACIÓN ────────────────────────────────────────────────────────────────
function setupNav() {
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
}

// ── UTILIDADES DE FECHA ───────────────────────────────────────────────────────
function calcularFechaFin(fechaInicio, plan) {
  const d = new Date(fechaInicio);
  const meses = plan === '3 meses' ? 3 : 2;
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().split('T')[0];
}

function diasRestantes(fechaFin) {
  if (!fechaFin) return null;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const fin = new Date(fechaFin); fin.setHours(0,0,0,0);
  return Math.ceil((fin - hoy) / (1000 * 60 * 60 * 24));
}

function badgeVencimiento(fechaFin, activo) {
  if (activo !== 'true') return `<span class="badge badge-red">Inactivo</span>`;
  const dias = diasRestantes(fechaFin);
  if (dias === null) return `<span class="badge badge-green">Activo</span>`;
  if (dias < 0)  return `<span class="badge badge-red">Vencido</span>`;
  if (dias <= 7) return `<span class="badge" style="background:rgba(245,158,11,0.2);color:#F59E0B;">⚠️ ${dias}d</span>`;
  return `<span class="badge badge-green">✓ ${dias}d</span>`;
}

function formatFecha(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [usuariosSnap, preguntasSnap, resultadosSnap] = await Promise.all([
      getDocs(collection(db, 'Usuarios')),
      getDocs(collection(db, 'Preguntas')),
      getDocs(collection(db, 'resultados'))
    ]);

    // Auto-expirar vencidos
    const batch = writeBatch(db);
    let expiraron = 0;
    usuariosSnap.forEach(d => {
      const u = d.data();
      if (u.activo === 'true' && u.fechaFin) {
        const dias = diasRestantes(u.fechaFin);
        if (dias !== null && dias < 0) {
          batch.update(doc(db, 'Usuarios', u.dni), { activo: 'false' });
          expiraron++;
        }
      }
    });
    if (expiraron > 0) {
      await batch.commit();
      showToast(`${expiraron} cuenta(s) vencida(s) desactivada(s) automáticamente`, 'error');
    }

    document.getElementById('stat-usuarios').textContent = usuariosSnap.size;
    document.getElementById('stat-preguntas').textContent = preguntasSnap.size;
    document.getElementById('stat-simulacros').textContent = resultadosSnap.size;

    // Alumnos por vencer en 7 días
    let porVencer = 0;
    usuariosSnap.forEach(d => {
      const u = d.data();
      if (u.activo === 'true' && u.fechaFin) {
        const dias = diasRestantes(u.fechaFin);
        if (dias !== null && dias >= 0 && dias <= 7) porVencer++;
      }
    });
    const el = document.getElementById('stat-por-vencer');
    if (el) el.textContent = porVencer;

    let totalPct = 0;
    resultadosSnap.forEach(d => { totalPct += (d.data().porcentaje || 0); });
    const avg = resultadosSnap.size > 0 ? (totalPct / resultadosSnap.size).toFixed(1) : '—';
    document.getElementById('stat-promedio').textContent = avg + (resultadosSnap.size > 0 ? '%' : '');

    loadRecentResults(resultadosSnap);
  } catch (e) { console.error('Error dashboard:', e); }
}

function loadRecentResults(snap) {
  const tbody = document.getElementById('tabla-resultados');
  if (!tbody) return;
  const rows = [];
  snap.forEach(d => rows.push(d.data()));
  rows.sort((a, b) => (b.fecha?.seconds || 0) - (a.fecha?.seconds || 0));
  tbody.innerHTML = rows.slice(0, 10).map(r => `
    <tr>
      <td>${r.dni || '—'}</td>
      <td>${r.nivel || '—'}</td>
      <td>${r.puntaje || 0}/${r.total || 72}</td>
      <td><span class="badge ${r.porcentaje >= 70 ? 'badge-green' : 'badge-red'}">${(r.porcentaje||0).toFixed(1)}%</span></td>
      <td>${r.fecha ? new Date(r.fecha.seconds*1000).toLocaleDateString('es-PE') : '—'}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty-row">Sin resultados aún</td></tr>';
}

// ── GESTIÓN DE USUARIOS ───────────────────────────────────────────────────────
function setupUsuariosTab() {
  loadUsuarios();
  document.getElementById('btn-nuevo-usuario').addEventListener('click', () => openModal());
  document.getElementById('form-usuario').addEventListener('submit', saveUsuario);
  document.getElementById('btn-cancelar').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', closeModal);
  document.getElementById('input-buscar').addEventListener('input', filterUsuarios);
  document.getElementById('u-plan').addEventListener('change', autoFechaFin);
  document.getElementById('u-fecha-inicio').addEventListener('change', autoFechaFin);
}

function autoFechaFin() {
  const fi   = document.getElementById('u-fecha-inicio').value;
  const plan = document.getElementById('u-plan').value;
  if (fi && plan) document.getElementById('u-fecha-fin').value = calcularFechaFin(fi, plan);
}

let allUsuarios = [];

async function loadUsuarios() {
  const snap = await getDocs(collection(db, 'Usuarios'));
  allUsuarios = [];
  snap.forEach(d => allUsuarios.push(d.data()));
  allUsuarios.sort((a, b) => {
    const da = diasRestantes(a.fechaFin) ?? 9999;
    const db_ = diasRestantes(b.fechaFin) ?? 9999;
    return da - db_;
  });
  renderUsuarios(allUsuarios);
}

function renderUsuarios(list) {
  const tbody = document.getElementById('tabla-usuarios');
  tbody.innerHTML = list.map(u => `
    <tr>
      <td><strong>${u.dni}</strong></td>
      <td>${u.nombre}</td>
      <td><span class="badge badge-nivel-${u.nivel}">${u.nivel}</span></td>
      <td>${u.plan}</td>
      <td style="font-size:0.8rem; white-space:nowrap; line-height:1.6;">
        ${u.fechaInicio ? `<span style="color:var(--gris-suave);">Inicio: ${formatFecha(u.fechaInicio)}</span><br>` : ''}
        ${u.fechaFin    ? `<strong>Vence: ${formatFecha(u.fechaFin)}</strong>` : '—'}
      </td>
      <td>${badgeVencimiento(u.fechaFin, u.activo)}</td>
      <td class="actions-cell">
        <button class="btn-icon" onclick="editUsuario('${u.dni}')" title="Editar">✏️</button>
        <button class="btn-icon" onclick="toggleUsuario('${u.dni}','${u.activo}')" title="${u.activo==='true'?'Desactivar':'Activar'}">${u.activo==='true'?'🔒':'🔓'}</button>
        <button class="btn-icon" onclick="renovarUsuario('${u.dni}')" title="Renovar">🔄</button>
        <button class="btn-icon" onclick="deleteUsuario('${u.dni}')" title="Eliminar">🗑️</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty-row">Sin usuarios registrados</td></tr>';
}

function filterUsuarios(e) {
  const q = e.target.value.toLowerCase();
  renderUsuarios(allUsuarios.filter(u => u.dni.includes(q) || u.nombre.toLowerCase().includes(q)));
}

function openModal(data = null) {
  document.getElementById('form-usuario').reset();
  document.getElementById('modal-title').textContent = data ? 'Editar Usuario' : 'Nuevo Usuario';
  document.getElementById('u-dni').disabled = !!data;
  const hoy = new Date().toISOString().split('T')[0];
  if (data) {
    document.getElementById('u-dni').value         = data.dni;
    document.getElementById('u-nombre').value      = data.nombre;
    document.getElementById('u-nivel').value       = data.nivel;
    document.getElementById('u-plan').value        = data.plan;
    document.getElementById('u-telefono').value    = data.telefono || '';
    document.getElementById('u-activo').value      = data.activo;
    document.getElementById('u-fecha-inicio').value = data.fechaInicio || hoy;
    document.getElementById('u-fecha-fin').value   = data.fechaFin || '';
  } else {
    document.getElementById('u-fecha-inicio').value = hoy;
  }
  document.getElementById('modal-usuario').classList.add('active');
  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modal-usuario').classList.remove('active');
  document.getElementById('modal-overlay').classList.remove('active');
}

async function saveUsuario(e) {
  e.preventDefault();
  const dni         = document.getElementById('u-dni').value.trim();
  const nombre      = document.getElementById('u-nombre').value.trim();
  const nivel       = document.getElementById('u-nivel').value;
  const plan        = document.getElementById('u-plan').value;
  const telefono    = document.getElementById('u-telefono').value.trim();
  const activo      = document.getElementById('u-activo').value;
  const password    = document.getElementById('u-password').value.trim();
  const fechaInicio = document.getElementById('u-fecha-inicio').value;
  const fechaFin    = document.getElementById('u-fecha-fin').value;

  if (!dni || !nombre || !nivel || !plan) {
    showToast('Completa todos los campos obligatorios', 'error'); return;
  }

  const btn = document.getElementById('btn-save-usuario');
  btn.disabled = true; btn.textContent = 'Guardando...';

  try {
    const ref = doc(db, 'Usuarios', dni);
    const existing = await getDoc(ref);
    if (!password && !existing.exists()) {
      showToast('Contraseña requerida para nuevo usuario', 'error');
      btn.disabled = false; btn.textContent = 'Guardar'; return;
    }
    const data = { dni, nombre, nivel, plan, telefono, activo, fechaInicio, fechaFin };
    if (password) data.password = password;
    await setDoc(ref, data, { merge: true });
    showToast('Usuario guardado ✓', 'success');
    closeModal(); loadUsuarios(); loadDashboard();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

window.editUsuario = async (dni) => {
  const snap = await getDoc(doc(db, 'Usuarios', dni));
  if (snap.exists()) openModal(snap.data());
};

window.toggleUsuario = async (dni, activo) => {
  const nuevo = activo === 'true' ? 'false' : 'true';
  await updateDoc(doc(db, 'Usuarios', dni), { activo: nuevo });
  showToast(`Usuario ${nuevo === 'true' ? 'activado' : 'desactivado'}`, 'success');
  loadUsuarios();
};

window.renovarUsuario = async (dni) => {
  const snap = await getDoc(doc(db, 'Usuarios', dni));
  if (!snap.exists()) return;
  const u = snap.data();
  const hoy = new Date().toISOString().split('T')[0];
  const nuevaFin = calcularFechaFin(hoy, u.plan);
  if (!confirm(`¿Renovar plan de ${u.nombre}?\nNueva fecha de vencimiento: ${formatFecha(nuevaFin)}`)) return;
  await updateDoc(doc(db, 'Usuarios', dni), { fechaInicio: hoy, fechaFin: nuevaFin, activo: 'true' });
  showToast(`Renovado hasta ${formatFecha(nuevaFin)} ✓`, 'success');
  loadUsuarios(); loadDashboard();
};

window.deleteUsuario = async (dni) => {
  if (!confirm(`¿Eliminar DNI ${dni}? No se puede deshacer.`)) return;
  await deleteDoc(doc(db, 'Usuarios', dni));
  showToast('Usuario eliminado', 'success');
  loadUsuarios(); loadDashboard();
};

// ── CARGA MASIVA JSON ─────────────────────────────────────────────────────────
function setupCargaTab() {
  const dropzone = document.getElementById('dropzone');
  const inputFile = document.getElementById('input-json');
  dropzone.addEventListener('click', () => inputFile.click());
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); });
  inputFile.addEventListener('change', e => handleFile(e.target.files[0]));
  document.getElementById('btn-cargar').addEventListener('click', uploadToFirestore);
  document.getElementById('btn-limpiar').addEventListener('click', clearPreview);
}

let jsonData = null;

function handleFile(file) {
  if (!file || !file.name.endsWith('.json')) { showToast('Solo .json', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      jsonData = JSON.parse(e.target.result);
      if (!Array.isArray(jsonData)) throw new Error('Debe ser un array []');
      renderPreview(jsonData);
    } catch (err) { showToast('JSON inválido: ' + err.message, 'error'); jsonData = null; }
  };
  reader.readAsText(file);
}

function renderPreview(data) {
  const intermedio = data.filter(q => q.nivel === 'intermedio').length;
  const avanzado   = data.filter(q => q.nivel === 'avanzado').length;
  const temas      = [...new Set(data.map(q => q.tema))];
  document.getElementById('preview-stats').innerHTML = `
    <div class="preview-stat"><span class="ps-num">${data.length}</span><span class="ps-label">Total</span></div>
    <div class="preview-stat"><span class="ps-num">${intermedio}</span><span class="ps-label">Intermedio</span></div>
    <div class="preview-stat"><span class="ps-num">${avanzado}</span><span class="ps-label">Avanzado</span></div>
    <div class="preview-stat"><span class="ps-num">${temas.length}</span><span class="ps-label">Temas</span></div>
  `;
  document.getElementById('preview-tabla').innerHTML = data.slice(0, 5).map((q, i) => `
    <tr>
      <td>${q.id || 'auto_'+i}</td>
      <td class="pregunta-cell">${q.Pregunta?.substring(0,60)}...</td>
      <td><span class="badge badge-nivel-${q.nivel}">${q.nivel}</span></td>
      <td>${q.tema}</td>
      <td>${q.correcta?.substring(0,30)}...</td>
    </tr>
  `).join('') + (data.length > 5 ? `<tr><td colspan="5" class="empty-row">... y ${data.length-5} más</td></tr>` : '');
  document.getElementById('preview-container').style.display = 'block';
  document.getElementById('btn-cargar').disabled = false;
}

async function uploadToFirestore() {
  if (!jsonData) return;
  const btn = document.getElementById('btn-cargar');
  btn.disabled = true;
  document.getElementById('upload-progress').style.display = 'block';
  let success = 0, errors = 0;
  for (let i = 0; i < jsonData.length; i += 499) {
    const chunk = jsonData.slice(i, i + 499);
    const batch = writeBatch(db);
    chunk.forEach((q, idx) => {
      const id = q.id || `pregunta_${String(i+idx+1).padStart(3,'0')}`;
      const { id: _id, ...rest } = q;
      batch.set(doc(db, 'Preguntas', id), rest, { merge: true });
    });
    try { await batch.commit(); success += chunk.length; }
    catch(e) { errors += chunk.length; }
    const pct = Math.round(((i+chunk.length)/jsonData.length)*100);
    document.getElementById('progress-bar').style.width = pct+'%';
    document.getElementById('progress-text').textContent = `Cargando... ${pct}%`;
  }
  document.getElementById('progress-text').textContent = `✅ ${success} preguntas cargadas${errors>0?`, ${errors} con errores`:''}`;
  showToast(`${success} preguntas sembradas ✓`, 'success');
  loadDashboard(); btn.disabled = false;
}

function clearPreview() {
  jsonData = null;
  document.getElementById('preview-container').style.display = 'none';
  document.getElementById('upload-progress').style.display = 'none';
  document.getElementById('btn-cargar').disabled = true;
  document.getElementById('input-json').value = '';
  document.getElementById('progress-bar').style.width = '0%';
}

function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  setTimeout(() => toast.classList.remove('show'), 3500);
}
