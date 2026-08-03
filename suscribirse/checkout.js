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
// ─────────────────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithCredential, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { Purchases } from 'https://esm.sh/@revenuecat/purchases-js@0.15.1';

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of ['loading', 'signin', 'plans-view', 'success', 'fatal']) {
    $(s).classList.toggle('hidden', s !== id);
  }
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

const fmtPrice = (pkg) => {
  // purchases-js expone el precio formateado en el producto.
  const p = pkg.rcBillingProduct?.currentPrice ?? pkg.webBillingProduct?.currentPrice;
  return p?.formattedPrice ?? '';
};
const planName = (pkg) => {
  const id = (pkg.identifier || '').toLowerCase();
  if (id.includes('year') || id.includes('annual') || id === '$rc_annual') return 'Anual';
  if (id.includes('month') || id === '$rc_monthly') return 'Mensual';
  if (id.includes('week') || id === '$rc_weekly') return 'Semanal';
  return pkg.rcBillingProduct?.title ?? pkg.identifier;
};

// Render sin innerHTML: se construye el DOM con textContent (cero superficie de
// inyección, aunque los datos vengan de RevenueCat y no del usuario).
const renderPlans = () => {
  const el = $('plans');
  el.textContent = '';
  packages.forEach((pkg) => {
    const isAnnual = planName(pkg) === 'Anual';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = planName(pkg);
    if (isAnnual) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Mejor valor';
      name.appendChild(badge);
    }

    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = fmtPrice(pkg);

    const div = document.createElement('div');
    div.className = 'plan' + (pkg === selected ? ' selected' : '');
    div.append(name, price);
    div.onclick = () => { selected = pkg; renderPlans(); };
    el.appendChild(div);
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
  selected = packages.find((p) => planName(p) === 'Anual') ?? packages[0];
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
