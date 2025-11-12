const BASE_URL = 'https://api.paystack.co';

let PAYSTACK_SECRET_KEY, setupError, setupPromise;

const ensureReady = async () => {
  if (setupError) throw setupError;
  if (PAYSTACK_SECRET_KEY) return;

  if (!setupPromise) {
    setupPromise = (async () => {
      PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
      if (!PAYSTACK_SECRET_KEY) {
        setupError = new Error('Missing Paystack secret key.');
      }
    })();
  }

  await setupPromise;
  if (setupError) throw setupError;
};

const paystackFetch = async (endpoint, method = 'GET', body = null) => {
  await ensureReady();

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Paystack error: ${endpoint}`);
  return data;
};

const initializePayment = async (payload) => {
  const { email, amount } = payload || {};
  if (!email || !amount) throw new Error('Missing email or amount.');
  return paystackFetch('/transaction/initialize', 'POST', payload);
};

const verifyPayment = async (reference) => {
  if (!reference || typeof reference !== 'string') {
    throw new Error('Reference must be a string.');
  }
  return paystackFetch(`/transaction/verify/${reference}`);
};

const withdrawFunds = async (payload) => {
  const { amount, recipient } = payload || {};
  if (!amount || !recipient) throw new Error('Missing amount or recipient.');
  return paystackFetch('/transfer', 'POST', payload);
};

export { initializePayment, verifyPayment, withdrawFunds };
