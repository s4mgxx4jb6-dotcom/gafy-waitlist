// ─────────────────────────────────────────────────────────────────────────
//  Gafy Plus — checkout web (RevenueCat Web Billing + Stripe)
//
//  SEGURIDAD — sobre las claves de este archivo:
//  - FIREBASE_CONFIG.apiKey NO es un secreto: es un identificador público que
//    el SDK web necesita. La protección real son las reglas de Firestore, el
//    login de Firebase Auth y los dominios autorizados. (Doc oficial de Google.)
//  - RC_WEB_BILLING_API_KEY (rcb_...) es la clave PÚBLICA de RevenueCat Web
//    Billing (como la publishable key de Stripe). Va en el cliente por diseño;
//    la validación real es server-side.
//  Los secretos de verdad (Stripe secret key, RevenueCat secret key, Firebase
//  Admin service account) NUNCA deben aparecer aquí ni en el repo.
// ─────────────────────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBzmOImMut--qInWIIHCrHj4RJJQqSbVHE',
  authDomain: 'gafy-f674f.firebaseapp.com',
  projectId: 'gafy-f674f',
  storageBucket: 'gafy-f674f.firebasestorage.app',
  messagingSenderId: '652137234079',
  appId: '1:652137234079:web:79e6de3b00f61568666caa',
};

// Sandbox (modo test). Para producción: cambiar por la key live (rcb_...).
const RC_WEB_BILLING_API_KEY = 'rcb_sb_szJUkByfCRKlpNfPEaQQvjqzR';

// Debe coincidir con el entitlement de RevenueCat (igual que en la app).
const ENTITLEMENT_ID = 'plus';

// Cliente OAuth web (el mismo "ID de cliente web" del proveedor Google en
// Firebase). Se usa con Google Identity Services: el botón devuelve un ID token
// que se canjea con signInWithCredential, sin el iframe cross-domain de
// firebaseapp.com (que Chrome rompe con el particionado de almacenamiento).
const GOOGLE_CLIENT_ID = '652137234079-l4gqtbi1752bu3p3od9ah4pq9j9ofar8.apps.googleusercontent.com';

// Services ID de Apple para web (creado en Apple Developer, distinto del App ID
// de la app). Es el clientId de "Sign in with Apple JS".
const APPLE_SERVICES_ID = 'com.gafy.web';
const APPLE_REDIRECT_URI = 'https://gafy.app/suscribirse/';
// ─────────────────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, OAuthProvider, signInWithCredential, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { Purchases } from 'https://esm.sh/@revenuecat/purchases-js@0.15.1';

const $ = (id) => document.getElementById(id);
// El hero (headline + mockups del producto) se muestra en login y en planes,
// como el paywall de la app; se oculta en cargando/éxito/error.
const HERO_IN = new Set(['signin', 'plans-view']);
const show = (id) => {
  for (const s of ['loading', 'signin', 'plans-view', 'success', 'fatal']) {
    $(s).classList.toggle('hidden', s !== id);
  }
  $('hero').classList.toggle('hidden', !HERO_IN.has(id));
};
const fatal = (msg) => { $('fatalMsg').textContent = msg; show('fatal'); };

// Guard de config sin rellenar.
if (FIREBASE_CONFIG.apiKey.startsWith('TODO') || RC_WEB_BILLING_API_KEY.startsWith('TODO')) {
  fatal('Falta configurar las claves (Firebase Web y RevenueCat Web Billing) en este archivo.');
  throw new Error('config incompleta');
}

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
await setPersistence(auth, browserLocalPersistence);

let purchases = null;
let packages = [];
let selected = null;

const PERIOD = { weekly: '/sem', monthly: '/mes', annual: '/año' };
const LABEL = { weekly: 'Semanal', monthly: 'Mensual', annual: 'Anual' };
const WEEKS = { monthly: 4.345, annual: 52.14 };

const planKind = (pkg) => {
  const id = (pkg.identifier || '').toLowerCase();
  if (id.includes('year') || id.includes('annual') || id === '$rc_annual') return 'annual';
  if (id.includes('month') || id === '$rc_monthly') return 'monthly';
  if (id.includes('week') || id === '$rc_weekly') return 'weekly';
  return 'other';
};
const priceOf = (pkg) => pkg?.rcBillingProduct?.currentPrice ?? pkg?.webBillingProduct?.currentPrice ?? null;
const fmtPrice = (pkg) => priceOf(pkg)?.formattedPrice ?? '';

// Formatea un monto al estilo de RevenueCat ("COP 3,652" / "USD 1.99").
function fmtAmount(amount, currency) {
  const noDecimals = ['COP', 'CLP', 'JPY', 'KRW'].includes(currency);
  const s = amount.toLocaleString('en-US', {
    minimumFractionDigits: noDecimals ? 0 : 2,
    maximumFractionDigits: noDecimals ? 0 : 2,
  });
  return (currency ? currency + ' ' : '') + s;
}

// "≈ COP X/sem" para mensual y anual: pone todos los planes en el mismo plazo.
function perWeek(pkg) {
  const p = priceOf(pkg);
  const div = WEEKS[planKind(pkg)];
  if (!p || p.amountMicros == null || !div) return null;
  return '≈ ' + fmtAmount((p.amountMicros / 1e6) / div, p.currency ?? p.currencyCode ?? '') + '/sem';
}

// Badge del plan anual: "Ahorra X%" vs pagar semanal todo el año (o mensual x12).
function annualBadge() {
  const annual = packages.find((p) => planKind(p) === 'annual');
  if (!annual) return null;
  const a = priceOf(annual)?.amountMicros;
  const weekly = priceOf(packages.find((p) => planKind(p) === 'weekly'))?.amountMicros;
  const monthly = priceOf(packages.find((p) => planKind(p) === 'monthly'))?.amountMicros;
  const base = weekly ? weekly * 52 : monthly ? monthly * 12 : null;
  if (a && base) {
    const pct = Math.round((1 - a / base) * 100);
    if (pct > 0) return 'Ahorra ' + pct + '%';
  }
  return 'Mejor valor';
}

// Construye el DOM con textContent (cero superficie de inyección).
const mk = (cls, text) => {
  const d = document.createElement('div');
  d.className = cls;
  if (text != null) d.textContent = text;
  return d;
};

const renderPlans = () => {
  const wrap = $('plans');
  wrap.textContent = '';
  const badge = annualBadge();
  packages.forEach((pkg) => {
    const kind = planKind(pkg);

    const main = mk('plan-main');
    main.appendChild(mk('plan-name', LABEL[kind] ?? pkg.identifier));

    const price = mk('price', fmtPrice(pkg));
    const period = document.createElement('span');
    period.className = 'period';
    period.textContent = PERIOD[kind] ?? '';
    price.appendChild(period);
    const priceBox = mk('plan-price');
    priceBox.appendChild(price);
    const pw = perWeek(pkg);
    if (pw) priceBox.appendChild(mk('per', pw));

    const card = mk('plan' + (pkg === selected ? ' selected' : ''));
    card.append(mk('radio'), main, priceBox);
    if (kind === 'annual' && badge) card.appendChild(mk('badge', badge));
    card.onclick = () => { selected = pkg; renderPlans(); };
    wrap.appendChild(card);
  });
};

const loadOfferings = async (uid) => {
  purchases = Purchases.configure(RC_WEB_BILLING_API_KEY, uid);
  const offerings = await purchases.getOfferings();
  const current = offerings.current;
  if (!current || !current.availablePackages?.length) {
    fatal('No hay planes disponibles. Revisa el offering "current" en RevenueCat.');
    return;
  }
  packages = current.availablePackages;
  // Preselecciona el anual si existe.
  selected = packages.find((p) => planKind(p) === 'annual') ?? packages[0];
  renderPlans();
  show('plans-view');
};

$('subscribeBtn').onclick = async () => {
  if (!selected || !purchases) return;
  $('subscribeBtn').disabled = true;
  $('purchaseErr').classList.add('hidden');
  try {
    const { customerInfo } = await purchases.purchase({ rcPackage: selected });
    if (customerInfo.entitlements.active[ENTITLEMENT_ID]) {
      show('success');
    } else {
      throw new Error('El pago no activó el entitlement.');
    }
  } catch (e) {
    if (e?.errorCode === 'UserCancelledError' || /cancel/i.test(e?.message || '')) {
      // cancelado por el usuario: no mostramos error
    } else {
      $('purchaseErr').textContent = 'No se pudo completar el pago. Inténtalo de nuevo.';
      $('purchaseErr').classList.remove('hidden');
    }
  } finally {
    $('subscribeBtn').disabled = false;
  }
};

// Google Identity Services: carga el SDK, lo inicializa y renderiza el botón
// oficial de Google. El botón devuelve un ID token que se canjea con
// signInWithCredential — NO pasa por el iframe de firebaseapp.com, así que
// funciona con el almacenamiento particionado de Chrome (que rompía el popup).
function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar Google Identity Services.'));
    document.head.appendChild(s);
  });
}

let _gisReady = false;
async function initGoogleButton() {
  if (_gisReady) return;
  await loadGis();
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: async (resp) => {
      try {
        const cred = GoogleAuthProvider.credential(resp.credential);
        await signInWithCredential(auth, cred);
        // onAuthStateChanged continúa el flujo (carga de planes).
      } catch (e) {
        fatal('No se pudo iniciar sesión. ' + (e?.message || ''));
      }
    },
  });
  google.accounts.id.renderButton($('googleBtn'), {
    theme: 'filled_blue', size: 'large', text: 'continue_with', shape: 'pill', width: 300,
  });
  _gisReady = true;
}

// Sign in with Apple (JS SDK) → ID token → signInWithCredential. Igual que GIS,
// evita el iframe de firebaseapp.com (el popup habla con appleid.apple.com y
// devuelve el token por postMessage al opener), así funciona con el
// almacenamiento particionado de Chrome.
function loadAppleSdk() {
  return new Promise((resolve, reject) => {
    if (window.AppleID?.auth) return resolve();
    const s = document.createElement('script');
    s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar Sign in with Apple.'));
    document.head.appendChild(s);
  });
}

function randomNonce(len = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

$('appleBtn').onclick = async () => {
  try {
    await loadAppleSdk();
    // rawNonce se pasa a Firebase; Apple recibe su SHA-256 (así lo verifica Firebase).
    const rawNonce = randomNonce();
    const hashedNonce = await sha256hex(rawNonce);
    AppleID.auth.init({
      clientId: APPLE_SERVICES_ID,
      scope: 'name email',
      redirectURI: APPLE_REDIRECT_URI,
      usePopup: true,
      nonce: hashedNonce,
    });
    const res = await AppleID.auth.signIn();
    const idToken = res?.authorization?.id_token;
    if (!idToken) throw new Error('Apple no devolvió token.');
    const cred = new OAuthProvider('apple.com').credential({ idToken, rawNonce });
    await signInWithCredential(auth, cred);
    // onAuthStateChanged continúa el flujo (carga de planes).
  } catch (e) {
    // Popup cerrado/cancelado por el usuario: no mostramos error.
    const code = e?.error || e?.message || '';
    if (/popup_closed|user_cancel|cancel/i.test(code)) return;
    fatal('No se pudo iniciar sesión con Apple. ' + code);
  }
};

$('signout1').onclick = () => signOut(auth);

// Enruta según sesión. onAuthStateChanged también captura la sesión ya
// persistida (el usuario que venía logueado desde la app en el mismo navegador).
// La identidad SIEMPRE sale del login autenticado (user.uid), nunca del
// parámetro app_user_id de la URL — así nadie puede suplantar otra cuenta.
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    show('signin');
    initGoogleButton().catch((e) => fatal(e?.message || 'Error cargando el login de Google.'));
    return;
  }
  $('userEmail').textContent = user.email ?? user.uid;
  show('loading');
  try {
    await loadOfferings(user.uid);   // appUserID = uid de Firebase = el de la app
  } catch (e) {
    fatal('Error cargando los planes. ' + (e?.message || ''));
  }
});
