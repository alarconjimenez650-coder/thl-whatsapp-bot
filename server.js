// server.js (TH Logistics) – listo para ejecutar
// WhatsApp Cloud API bot: flujo de cotización + PDF + CSV + comando "precio"
// Modo local: `npm ci && npm start`  (requiere Node 18+)

import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import { createObjectCsvWriter } from 'csv-writer';
import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import puppeteer from 'puppeteer';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// === Public dir for media & PDFs ===
const PUBLIC_DIR = path.join(process.cwd(), 'public');
await fse.ensureDir(PUBLIC_DIR);
app.use('/public', express.static(PUBLIC_DIR));

// === ENV ===
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'thl-verify-2025';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';
const LOGO_URL = process.env.LOGO_URL || 'https://placehold.co/600x200?text=TH+Logistics';
const COMPANY_NAME = process.env.COMPANY_NAME || 'TH Logistics';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

// === In-memory session store (use Redis/DB in prod) ===
const sessions = new Map();
const STEPS = ['ask_identity','ask_description','ask_weight','ask_packing','ask_addresses','ask_date','ask_permits','ask_email','summary_and_quote'];

// === WhatsApp helpers ===
async function waSend(endpoint, payload){
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/${endpoint}`;
  const { data } = await axios.post(url, payload, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  return data;
}
async function waText(to, body){ return waSend('messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body } }); }
async function waImage(to, link, caption=''){ return waSend('messages', { messaging_product: 'whatsapp', to, type: 'image', image: { link, caption } }); }
async function waDoc(to, link, filename, caption=''){ return waSend('messages', { messaging_product: 'whatsapp', to, type: 'document', document: { link, filename, caption } }); }

async function waDownloadMedia(mediaId){
  const meta = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const fileRes = await axios.get(meta.data.url, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const ext = (meta.data.mime_type && meta.data.mime_type.split('/')[1]) || 'bin';
  const name = `packing_${mediaId}.${ext}`;
  const out = path.join(PUBLIC_DIR, name);
  fs.writeFileSync(out, fileRes.data);
  return `/public/${name}`;
}

// === CSV (lead DB) ===
const CSV_PATH = path.join(process.cwd(), 'clientes.csv');
const csvWriter = createObjectCsvWriter({ path: CSV_PATH, header: [
  { id: 'date', title: 'Fecha' },
  { id: 'phone', title: 'Telefono' },
  { id: 'client_name', title: 'Nombre' },
  { id: 'client_ruc', title: 'RUC' },
  { id: 'client_razon', title: 'RazonSocial' },
  { id: 'email', title: 'Email' }
], append: true });
async function saveLead(row){ await csvWriter.writeRecords([row]); }

// === SUNAT (stub con variable ENV opcional) ===
async function querySUNAT(ruc){
  const api = process.env.SUNAT_API_URL; // si defines una API propia, el bot autocompleta razón social
  if(!api) return null;
  try {
    const { data } = await axios.get(`${api}?ruc=${encodeURIComponent(ruc)}`);
    return data; // { razonSocial, direccion, ... }
  } catch (e) {
    console.error('SUNAT stub error', e?.response?.data || e.message);
    return null;
  }
}

// === PDF renderer ===
async function renderQuotePDF(data){
  const templatePath = path.join(process.cwd(), 'templates', 'quote.html');
  const html = fs.readFileSync(templatePath, 'utf8')
    .replace(/{{LOGO_URL}}/g, LOGO_URL)
    .replace(/{{COMPANY_NAME}}/g, COMPANY_NAME)
    .replace(/{{QUOTE_NUMBER}}/g, data.number)
    .replace(/{{ISSUE_DATE}}/g, data.issueDate)
    .replace(/{{CLIENT_NAME}}/g, data.client.name)
    .replace(/{{CLIENT_RUC}}/g, data.client.ruc)
    .replace(/{{CLIENT_ADDRESS}}/g, data.client.address || '-')
    .replace(/{{DESCRIPTION}}/g, data.description)
    .replace(/{{WEIGHT}}/g, String(data.weight))
    .replace(/{{PICKUP}}/g, data.pickup)
    .replace(/{{DROPOFF}}/g, data.dropoff)
    .replace(/{{SERVICE_DATE}}/g, data.serviceDate)
    .replace(/{{PERMITS}}/g, data.permits)
    .replace(/{{EMAIL}}/g, data.email)
    .replace(/{{SUBTOTAL}}/g, data.subtotal)
    .replace(/{{IGV}}/g, data.igv)
    .replace(/{{TOTAL}}/g, data.total)
    .replace(/{{FOOT_NOTES}}/g, data.footNotes || '');

  const outName = `COT_${data.number.replace(/[^A-Za-z0-9_-]/g, '')}.pdf`;
  const outPath = path.join(PUBLIC_DIR, outName);
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
  await browser.close();
  return `/public/${outName}`;
}

// === Template bootstrap ===
const TEMPLATE_DIR = path.join(process.cwd(), 'templates');
await fse.ensureDir(TEMPLATE_DIR);
if (!fs.existsSync(path.join(TEMPLATE_DIR, 'quote.html'))){
  fs.writeFileSync(path.join(TEMPLATE_DIR, 'quote.html'), `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;color:#111}
  .row{display:flex;justify-content:space-between;align-items:center}
  .box{border:1px solid #ddd;padding:8px;border-radius:6px;margin:6px 0}
  .title{font-size:16px;font-weight:700}
  .muted{color:#666}
  table{width:100%;border-collapse:collapse}
  th,td{border:1px solid #ddd;padding:6px}
  th{background:#f6f6f6}
  .right{text-align:right}
  .sm{font-size:10px}
</style></head>
<body>
  <div class="row">
    <img src="{{LOGO_URL}}" alt="logo" style="height:60px"/>
    <div>
      <div class="title">COTIZACIÓN {{QUOTE_NUMBER}}</div>
      <div class="muted">Fecha Emisión: {{ISSUE_DATE}}</div>
    </div>
  </div>
  <div class="box">
    <strong>Cliente:</strong> {{CLIENT_NAME}} &nbsp; | &nbsp; <strong>RUC:</strong> {{CLIENT_RUC}}<br/>
    <strong>Dirección:</strong> {{CLIENT_ADDRESS}}
  </div>
  <div class="box">
    <strong>Descripción:</strong> {{DESCRIPTION}}<br/>
    <strong>Peso total:</strong> {{WEIGHT}} kg<br/>
    <strong>Recojo:</strong> {{PICKUP}}<br/>
    <strong>Entrega:</strong> {{DROPOFF}}<br/>
    <strong>Fecha de servicio:</strong> {{SERVICE_DATE}}<br/>
    <strong>Permisos/Docs:</strong> {{PERMITS}}<br/>
    <strong>Correo cotización:</strong> {{EMAIL}}
  </div>
  <table>
    <thead><tr><th>Item</th><th>Detalle</th><th class="right">V.U</th><th class="right">Importe</th></tr></thead>
    <tbody>
      <tr><td>1</td><td>Servicio de transporte</td><td class="right">{{SUBTOTAL}}</td><td class="right">{{SUBTOTAL}}</td></tr>
    </tbody>
    <tfoot>
      <tr><td colspan="3" class="right">IGV (18%)</td><td class="right">{{IGV}}</td></tr>
      <tr><td colspan="3" class="right"><strong>Total</strong></td><td class="right"><strong>{{TOTAL}}</strong></td></tr>
    </tfoot>
  </table>
  <div class="box sm">{{FOOT_NOTES}}</div>
</body></html>`);
}

// === Webhook verify ===
app.get('/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode==='subscribe' && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// === Webhook receive ===
app.post('/webhook', async (req,res)=>{
  try{
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!msg) return res.sendStatus(200);
    const from = msg.from;
    const type = msg.type;

    // Crear sesión al primer mensaje
    if(!sessions.has(from)){
      sessions.set(from, { step: 'ask_identity', data: { packing_urls: [], price: 0 } });
      await waImage(from, LOGO_URL, `¡Hola! Soy el asistente virtual de ${COMPANY_NAME}.`);
      await waText(from, 'Para iniciar la atención, por favor envía:\n1) *Nombre completo*\n2) *RUC (11 dígitos)*\n3) *Razón social*');
      return res.sendStatus(200);
    }

    const session = sessions.get(from);
    let userText = '';
    if(type==='text') userText = msg.text?.body?.trim() || '';

    // Operador: "precio 1500"
    if(/^precio\s+\d+(?:[\.,]\d+)?$/i.test(userText)){
      const p = parseFloat(userText.split(/\s+/)[1].replace(',','.'));
      session.data.price = p;
      const igv = +(p*0.18).toFixed(2);
      const total = +(p+igv).toFixed(2);
      const number = `${dayjs().format('YYYYMMDD-HHmm')}-${from.slice(-4)}`;
      const rel = await renderQuotePDF({
        number,
        issueDate: dayjs().format('DD.MM.YYYY'),
        client: { name: session.data.client_razon || session.data.client_name || '-', ruc: session.data.client_ruc || '-', address: '-' },
        description: session.data.desc || '-',
        weight: session.data.weight || 0,
        pickup: session.data.pickup_address || '-',
        dropoff: session.data.dropoff_address || '-',
        serviceDate: session.data.service_date || '-',
        permits: session.data.permits || '-',
        email: session.data.email || '-',
        subtotal: p.toFixed(2), igv: igv.toFixed(2), total: total.toFixed(2),
        footNotes: defaultFootNotes()
      });
      const base = PUBLIC_BASE_URL || (req.protocol+'://'+req.get('host'));
      await waDoc(from, base+rel, path.basename(rel), 'Cotización actualizada con precios.');
      return res.sendStatus(200);
    }

    // Media: packing list
    if(['image','document','audio','video'].includes(type)){
      const id = msg[type]?.id;
      if(id){
        const saved = await waDownloadMedia(id);
        if(saved){ await waText(from, '✅ Packing list recibido. Envía más o escribe "ok".'); session.data.packing_urls.push(saved); }
        return res.sendStatus(200);
      }
    }

    // Flujo por pasos
    switch(session.step){
      case 'ask_identity': {
        const lines = userText.split(/\n|\r/).map(s=>s.trim()).filter(Boolean);
        const bundle = lines.join(' | ');
        const ruc = (bundle.match(/(\d{11})/)||[])[1];
        if(!bundle || !ruc){ await waText(from,'Formato no válido. Envíame:\n*Nombre completo*\n*RUC (11 dígitos)*\n*Razón social*'); break; }
        session.data.client_name = lines[0] || session.data.client_name;
        session.data.client_ruc = ruc;
        session.data.client_razon = lines[2] || lines[1] || session.data.client_razon;
        const s = await querySUNAT(ruc); if(s?.razonSocial) session.data.client_razon = s.razonSocial;
        await waText(from,'2) Describe brevemente tu requerimiento (tipo de carga, origen/destino tentativo, etc.).');
        session.step = 'ask_description';
        break;
      }
      case 'ask_description': {
        if(!userText){ await waText(from,'Escribe una breve descripción del servicio.'); break; }
        session.data.desc = userText;
        await waText(from,'3) Indica el *peso total (kg)* a transportar.');
        session.step = 'ask_weight';
        break;
      }
      case 'ask_weight': {
        const w = parseFloat((userText||'').replace(',','.'));
        if(!w || w<=0){ await waText(from,'Envía el peso total en kg (ej.: 1200)'); break; }
        session.data.weight = w;
        await waText(from,'4) Envía el *packing list* (imágenes o PDF).');
        session.step = 'ask_packing';
        break;
      }
      case 'ask_packing': {
        if(userText.toLowerCase()==='ok' || (session.data.packing_urls||[]).length>0){
          await waText(from,'5) Indica las *direcciones* de recojo y entrega (ambas).');
          session.step = 'ask_addresses';
        } else {
          await waText(from,'Adjunta el packing list. Cuando termines, escribe "ok".');
        }
        break;
      }
      case 'ask_addresses': {
        const parts = userText.split(/\n|\r|->/);
        if(parts.length<2){ await waText(from,'Formato:\n*Recojo:* ...\n*Entrega:* ...'); break; }
        session.data.pickup_address = parts[0].replace(/Recojo: */i,'').trim();
        session.data.dropoff_address = parts[1].replace(/Entrega: */i,'').trim();
        await waText(from,'6) Indica la *fecha del servicio* (AAAA-MM-DD).');
        session.step = 'ask_date';
        break;
      }
      case 'ask_date': {
        const d = dayjs(userText);
        if(!d.isValid()){ await waText(from,'Fecha inválida. Formato AAAA-MM-DD (ej.: 2025-10-15).'); break; }
        session.data.service_date = d.format('YYYY-MM-DD');
        await waText(from,'7) ¿Requiere permisos/documentación especial? Responde “sí/no” y detalla si aplica.');
        session.step = 'ask_permits';
        break;
      }
      case 'ask_permits': {
        session.data.permits = userText || 'No especificado';
        await waText(from,'8) Indica el *correo electrónico* para el envío de la cotización.');
        session.step = 'ask_email';
        break;
      }
      case 'ask_email': {
        const ok = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(userText||'');
        if(!ok){ await waText(from,'Correo inválido. Ej.: ventas@tuempresa.com'); break; }
        session.data.email = (userText||'').trim();

        // Guardar lead CSV
        await saveLead({ date: dayjs().format('YYYY-MM-DD HH:mm'), phone: from, client_name: session.data.client_name, client_ruc: session.data.client_ruc, client_razon: session.data.client_razon, email: session.data.email });

        // Pre-cotización con montos 0 (operador luego envía: precio 1500)
        const number = `${dayjs().format('YYYYMMDD-HHmm')}-${from.slice(-4)}`;
        const subtotal = 0; const igv = +(subtotal*0.18).toFixed(2); const total = +(subtotal+igv).toFixed(2);
        const rel = await renderQuotePDF({
          number,
          issueDate: dayjs().format('DD.MM.YYYY'),
          client: { name: session.data.client_razon || session.data.client_name, ruc: session.data.client_ruc, address: '-' },
          description: session.data.desc,
          weight: session.data.weight,
          pickup: session.data.pickup_address,
          dropoff: session.data.dropoff_address,
          serviceDate: session.data.service_date,
          permits: session.data.permits,
          email: session.data.email,
          subtotal: subtotal.toFixed(2), igv: igv.toFixed(2), total: total.toFixed(2),
          footNotes: defaultFootNotes()
        });
        const base = PUBLIC_BASE_URL || (req.protocol+'://'+req.get('host'));
        await waText(from,'Gracias. He generado la *pre-cotización*. Para fijar precio, un operador debe enviar: precio 1500');
        await waDoc(from, base+rel, path.basename(rel), 'Pre-cotización (sin precios).');
        session.step = 'summary_and_quote';
        break;
      }
      default: {
        const t = (userText||'').toLowerCase();
        if(/menu|ayuda|opciones/.test(t)){
          await waText(from,'Opciones:\n- "cotizar" para iniciar.\n- "agente" para hablar con una persona.\n- Operador: *precio 1500* para recalcular PDF.');
        } else if(/agente|humano|asesor/.test(t)){
          await waText(from,'Te conecto con un asesor humano.');
          // TODO: Notificar a backoffice (correo/Slack)
        } else if(/cotiza|cotizar|nuevo/.test(t)){
          sessions.set(from, { step: 'ask_identity', data: { packing_urls: [], price: 0 } });
          await waText(from, 'Iniciemos una nueva cotización. Envíame:\n1) *Nombre completo*\n2) *RUC (11 dígitos)*\n3) *Razón social*');
        } else {
          await waText(from,'No te entendí. Escribe "menu" para ver opciones o "cotizar" para iniciar.');
        }
        break;
      }
    }

    res.sendStatus(200);
  }catch(e){ console.error('Webhook error:', e); res.sendStatus(500); }
});

function defaultFootNotes(){
  return 'Notas: Las tarifas no incluyen IGV (18%). Horas libres: 4 (2 carga / 2 descarga). Stand by por hora: 10% de la tarifa. Pernocte Lima: 50% de la tarifa. Falso Flete: 50%-100% según condiciones. Seguro de carga no incluido salvo se solicite. Carga peligrosa: recargo 20%.';
}

app.get('/', (_req,res)=>res.send('OK - Bot TH Logistics activo'));
const PORT = process.env.PORT || 3000; app.listen(PORT, ()=>console.log('Servidor en puerto', PORT));
